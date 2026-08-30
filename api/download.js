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

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const fileId = searchParams.get('fileId');
  const rawName = searchParams.get('name') || 'file';

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

    const filePath = infoData.result.file_path; // যেমন: photos/file_123.jpg
    const baseName = sanitizeFilename(rawName.replace(/\.[a-zA-Z0-9]{1,6}$/, '')); // পুরনো এক্সটেনশন থাকলে ফেলে দাও

    // ধাপ ২: আসল ফাইলটা Telegram থেকে স্ট্রিম হিসেবে টেনে আনা
    const fileRes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
    if (!fileRes.ok || !fileRes.body) {
      return new Response('ফাইল fetch করা যায়নি', { status: 502 });
    }

    const contentType = fileRes.headers.get('content-type') || 'application/octet-stream';

    // এক্সটেনশন প্রায়োরিটি: (১) file_path-এর আসল এক্সটেনশন, (২) content-type থেকে অনুমান, (৩) কিছুই না
    let ext = safeExtFromPath(filePath);
    if (!ext) ext = extFromContentType(contentType);
    const finalName = ext ? `${baseName}.${ext}` : baseName;

    // ধাপ ৩: Content-Disposition হেডারে সঠিক নাম বসিয়ে ইউজারকে পাঠানো —
    // ব্রাউজার এখন বাধ্য হয়ে এই নামেই ফাইলটা সেভ করবে (নিজের ডোমেইন থেকে আসছে বলে CORS সমস্যাও নেই)
    return new Response(fileRes.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${finalName}"`,
      },
    });
  } catch (e) {
    return new Response('সার্ভার এরর: ' + (e?.message || 'অজানা'), { status: 500 });
  }
}
