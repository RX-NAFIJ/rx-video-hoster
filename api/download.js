// api/download.js
// এই ফাইলটা তোমার Vercel প্রজেক্টের রুটে "api" ফোল্ডারের ভিতরে বসাও।
// Edge runtime ব্যবহার করা হচ্ছে কারণ এটা ফাইল স্ট্রিম করে পাঠায় —
// তাই বড় ভিডিও ফাইলেও (২০MB পর্যন্ত) মেমরি বাফারিং সমস্যা হয় না।

export const config = { runtime: 'edge' };

// ফাইল পাথ/নাম থেকে নিরাপদভাবে বেসনেম বের করা (স্ল্যাশ/ডট বিভ্রান্তি এড়াতে)
function safeExtFromPath(filePath){
  if(!filePath) return '';
  const basename = filePath.split('/').pop() || ''; // শুধু শেষ অংশ নেওয়া, ফোল্ডার বাদ
  const dotIdx = basename.lastIndexOf('.');
  if(dotIdx <= 0 || dotIdx === basename.length - 1) return ''; // ডট নেই বা অর্থহীন অবস্থানে
  return basename.slice(dotIdx + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Content-Type হেডার থেকে এক্সটেনশন অনুমান করা — Telegram-এর file_path-এ এক্সটেনশন
// না থাকলে (যেমন কিছু document আপলোডে হয়) এটা ব্যাকআপ হিসেবে কাজ করে
const MIME_TO_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/heic': 'heic', 'image/bmp': 'bmp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
  'video/webm': 'webm', 'video/3gpp': '3gp'
};
function extFromContentType(contentType){
  if(!contentType) return '';
  const clean = contentType.split(';')[0].trim().toLowerCase();
  return MIME_TO_EXT[clean] || '';
}

// নামের যেকোনো path separator/quote বাদ দিয়ে Content-Disposition-এর জন্য নিরাপদ করা
function sanitizeFilename(name){
  return String(name).replace(/[\\/:*?"<>|]/g, '_').trim() || 'file';
}

// ফাইলের প্রথম কয়েক বাইট (magic bytes/file signature) দেখে আসল ফরম্যাট চেনা —
// পুরনো ফাইলে mimeType সেভ করা না থাকলেও এটা কাজ করে, কারণ এটা ফাইলের ভিতরের
// আসল ডেটা দেখে সিদ্ধান্ত নেয়, নাম বা metadata-র উপর নির্ভর করে না।
function sniffExtFromBytes(bytes){
  const b = bytes;
  if(b.length >= 3 && b[0]===0xFF && b[1]===0xD8 && b[2]===0xFF) return 'jpg';
  if(b.length >= 8 && b[0]===0x89 && b[1]===0x50 && b[2]===0x4E && b[3]===0x47) return 'png';
  if(b.length >= 4 && b[0]===0x47 && b[1]===0x49 && b[2]===0x46 && b[3]===0x38) return 'gif';
  if(b.length >= 12 && b[0]===0x52 && b[1]===0x49 && b[2]===0x46 && b[3]===0x46 &&
     b[8]===0x57 && b[9]===0x45 && b[10]===0x42 && b[11]===0x50) return 'webp';
  if(b.length >= 8 && b[4]===0x66 && b[5]===0x74 && b[6]===0x79 && b[7]===0x70) return 'mp4'; // ....ftyp
  if(b.length >= 4 && b[0]===0x1A && b[1]===0x45 && b[2]===0xDF && b[3]===0xA3) return 'webm'; // EBML (mkv/webm)
  if(b.length >= 2 && b[0]===0x42 && b[1]===0x4D) return 'bmp';
  return '';
}

// Response body-র প্রথম কিছু বাইট পড়ে ফরম্যাট বের করা, তারপর সেই বাইটগুলোসহ
// পুরো স্ট্রিমটা আবার জোড়া লাগিয়ে ইউজারের কাছে পাঠানো (কোনো ডেটা হারায় না)
async function sniffAndRebuildStream(body){
  const reader = body.getReader();
  const chunks = [];
  let collected = 0;
  // অন্তত ১২ বাইট জমা না হওয়া পর্যন্ত পড়তে থাকা (magic byte চেক করার জন্য যথেষ্ট)
  while(collected < 12){
    const { done, value } = await reader.read();
    if(done) break;
    chunks.push(value);
    collected += value.length;
  }
  const head = new Uint8Array(collected);
  let offset = 0;
  for(const c of chunks){ head.set(c, offset); offset += c.length; }
  const ext = sniffExtFromBytes(head);

  // প্রথমে জমানো বাইট, তারপর বাকি স্ট্রিম — দুটো মিলিয়ে নতুন স্ট্রিম বানানো
  const rebuilt = new ReadableStream({
    async start(controller){
      controller.enqueue(head);
      try{
        while(true){
          const { done, value } = await reader.read();
          if(done) break;
          controller.enqueue(value);
        }
      }catch(e){ /* stream শেষে সমস্যা হলেও যা পাঠানো হয়ে গেছে সেটা থাকবে */ }
      controller.close();
    }
  });

  return { ext, stream: rebuilt };
}

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const fileId = searchParams.get('fileId');
  const rawName = searchParams.get('name') || 'file';
  const clientMime = searchParams.get('mime') || '';
  const itemType = searchParams.get('type') || ''; // 'photo' | 'video' — একদম শেষ ভরসার জন্য

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

  if (!fileId) {
    return new Response('Missing fileId', { status: 400 });
  }
  if (!BOT_TOKEN) {
    return new Response('TELEGRAM_BOT_TOKEN env var সেট করা নেই (Vercel প্রজেক্ট সেটিংসে যোগ করো)', { status: 500 });
  }

  try {
    // ধাপ ১: getFile কল করে আসল file_path বের করা (এখান থেকেই আসল এক্সটেনশন পাওয়া যাবে)
    const infoRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
    const infoData = await infoRes.json();

    if (!infoData.ok) {
      return new Response(infoData.description || 'getFile ব্যর্থ হয়েছে', { status: 502 });
    }

    const filePath = infoData.result.file_path; // যেমন: photos/file_123.jpg (document হলে এক্সটেনশন নাও থাকতে পারে)
    const baseName = sanitizeFilename(rawName.replace(/\.[a-zA-Z0-9]{1,6}$/, '')); // পুরনো এক্সটেনশন থাকলে ফেলে দাও

    // ধাপ ২: আসল ফাইলটা Telegram থেকে স্ট্রিম হিসেবে টেনে আনা
    const fileRes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
    if (!fileRes.ok || !fileRes.body) {
      return new Response('ফাইল fetch করা যায়নি', { status: 502 });
    }

    const tgContentType = fileRes.headers.get('content-type') || '';

    // এক্সটেনশন প্রায়োরিটি (উপরেরটা না পেলে নিচেরটায় যায়):
    // (১) file_path-এর আসল এক্সটেনশন — সবচেয়ে নির্ভরযোগ্য যখন থাকে
    // (২) ফাইলের আসল বাইট পড়ে সনাক্ত করা (পুরনো/নতুন সব ফাইলে কাজ করে, mimeType লাগে না)
    // (৩) আপলোডের সময় সেভ করা mimeType (নতুন আপলোডে থাকে)
    // (৪) Telegram-এর content-type হেডার
    // (৫) একদম শেষ ভরসা — photo/video টাইপ দেখে ডিফল্ট
    let ext = safeExtFromPath(filePath);
    let outStream = fileRes.body;

    if (!ext) {
      const sniffed = await sniffAndRebuildStream(fileRes.body);
      ext = sniffed.ext;
      outStream = sniffed.stream;
    }

    if (!ext) ext = extFromContentType(clientMime);
    if (!ext) ext = extFromContentType(tgContentType);
    if (!ext) ext = itemType === 'video' ? 'mp4' : (itemType === 'photo' ? 'jpg' : '');
    const finalName = ext ? `${baseName}.${ext}` : baseName;

    // আউটগোয়িং Content-Type হেডারও ঠিক রাখা (ব্রাউজার/অ্যাপ ফাইলটা চিনতে পারে)
    const outContentType = tgContentType && tgContentType !== 'application/octet-stream'
      ? tgContentType
      : (clientMime || tgContentType || 'application/octet-stream');

    // ধাপ ৩: Content-Disposition হেডারে সঠিক নাম বসিয়ে ইউজারকে পাঠানো —
    // ব্রাউজার এখন বাধ্য হয়ে এই নামেই ফাইলটা সেভ করবে (নিজের ডোমেইন থেকে আসছে বলে CORS সমস্যাও নেই)
    return new Response(outStream, {
      status: 200,
      headers: {
        'Content-Type': outContentType,
        'Content-Disposition': `attachment; filename="${finalName}"`,
      },
    });
  } catch (e) {
    return new Response('সার্ভার এরর: ' + (e?.message || 'অজানা'), { status: 500 });
  }
}
