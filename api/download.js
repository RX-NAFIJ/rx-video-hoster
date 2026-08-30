// api/download.js
// এই ফাইলটা তোমার Vercel প্রজেক্টের রুটে "api" ফোল্ডারের ভিতরে বসাও।
// Edge runtime ব্যবহার করা হচ্ছে কারণ এটা ফাইল স্ট্রিম করে পাঠায় —
// তাই বড় ভিডিও ফাইলেও (২০MB পর্যন্ত) মেমরি বাফারিং সমস্যা হয় না।

export const config = { runtime: 'edge' };

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
    const ext = (filePath.split('.').pop() || '').toLowerCase();
    const baseName = rawName.replace(/\.[^/.]+$/, ''); // পুরনো এক্সটেনশন থাকলে ফেলে দাও
    const finalName = ext ? `${baseName}.${ext}` : baseName;

    // ধাপ ২: আসল ফাইলটা Telegram থেকে স্ট্রিম হিসেবে টেনে আনা
    const fileRes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
    if (!fileRes.ok || !fileRes.body) {
      return new Response('ফাইল fetch করা যায়নি', { status: 502 });
    }

    // ধাপ ৩: Content-Disposition হেডারে সঠিক নাম বসিয়ে ইউজারকে পাঠানো —
    // ব্রাউজার এখন বাধ্য হয়ে এই নামেই ফাইলটা সেভ করবে (নিজের ডোমেইন থেকে আসছে বলে CORS সমস্যাও নেই)
    return new Response(fileRes.body, {
      status: 200,
      headers: {
        'Content-Type': fileRes.headers.get('content-type') || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${finalName}"`,
      },
    });
  } catch (e) {
    return new Response('সার্ভার এরর: ' + (e?.message || 'অজানা'), { status: 500 });
  }
}
