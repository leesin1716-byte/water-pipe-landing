const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const RATE_LIMIT_COUNT = 3;          // 동일 IP 최대 횟수
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10분
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 동일 번호 24시간 중복 차단

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // --- 입력 파싱 및 기본 검증 ---
  const { name, phone, time } = req.body || {};

  if (!name?.trim()) {
    return res.status(400).json({ error: '이름을 입력해 주세요.' });
  }
  const phoneClean = (phone || '').replace(/\D/g, '');
  if (
    !(phoneClean.length === 10 || phoneClean.length === 11) ||
    !/^01[016789]/.test(phoneClean)
  ) {
    return res.status(400).json({ error: '올바른 휴대폰 번호를 입력해 주세요.' });
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  // --- Supabase 클라이언트 ---
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const now = Date.now();
  const rateLimitSince = new Date(now - RATE_LIMIT_WINDOW_MS).toISOString();
  const dedupSince = new Date(now - DEDUP_WINDOW_MS).toISOString();

  // --- IP 레이트 리밋 (10분에 3회) ---
  const { count: ipCount } = await supabase
    .from('consultations')
    .select('*', { count: 'exact', head: true })
    .eq('ip', ip)
    .gte('created_at', rateLimitSince);

  if ((ipCount || 0) >= RATE_LIMIT_COUNT) {
    return res.status(429).json({
      error: '잠시 후 다시 시도해 주세요. (10분에 최대 3회)',
    });
  }

  // --- 동일 번호 24시간 중복 차단 ---
  const { count: phoneCount } = await supabase
    .from('consultations')
    .select('*', { count: 'exact', head: true })
    .eq('phone', phoneClean)
    .gte('created_at', dedupSince);

  if ((phoneCount || 0) > 0) {
    return res.status(409).json({
      error:
        '이미 상담 신청이 접수된 번호입니다. 빠른 시일 내에 연락드리겠습니다.',
    });
  }

  // --- DB 저장 ---
  const { error: insertError } = await supabase
    .from('consultations')
    .insert({
      name: name.trim(),
      phone: phoneClean,
      time_pref: time || null,
      ip,
    });

  if (insertError) {
    console.error('[consult] DB insert error:', insertError);
    return res.status(500).json({ error: '저장 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }

  // --- 이메일 알림 (실패해도 신청은 성공으로 처리) ---
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    const kst = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const phoneFormatted = phoneClean.replace(/(\d{3})(\d{3,4})(\d{4})/, '$1-$2-$3');

    await transporter.sendMail({
      from: `"KWPA 상담알림" <${process.env.GMAIL_USER}>`,
      to: process.env.NOTIFY_EMAIL || 'kwpca@naver.com',
      subject: `[상담신청] ${name.trim()} · ${phoneFormatted}`,
      html: `
        <div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;background:#f4f7fb;padding:28px;border-radius:14px;">
          <div style="background:#0e2a52;color:#fff;padding:18px 22px;border-radius:10px;margin-bottom:20px;">
            <div style="font-size:13px;opacity:.7;letter-spacing:.06em;margin-bottom:4px;">KWPA 수도배관세척관리총연합회</div>
            <div style="font-size:20px;font-weight:800;">새 상담 신청이 접수되었습니다</div>
          </div>
          <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,.08);">
            <tr>
              <td style="padding:14px 18px;border-bottom:1px solid #e3eaf2;color:#5b6b7c;font-size:13px;width:90px;">이름</td>
              <td style="padding:14px 18px;border-bottom:1px solid #e3eaf2;font-weight:700;color:#14213d;font-size:16px;">${name.trim()}</td>
            </tr>
            <tr>
              <td style="padding:14px 18px;border-bottom:1px solid #e3eaf2;color:#5b6b7c;font-size:13px;">연락처</td>
              <td style="padding:14px 18px;border-bottom:1px solid #e3eaf2;font-weight:700;color:#2d4ed5;font-size:16px;">${phoneFormatted}</td>
            </tr>
            <tr>
              <td style="padding:14px 18px;border-bottom:1px solid #e3eaf2;color:#5b6b7c;font-size:13px;">희망 시간</td>
              <td style="padding:14px 18px;border-bottom:1px solid #e3eaf2;color:#14213d;">${time || '언제든 가능'}</td>
            </tr>
            <tr>
              <td style="padding:14px 18px;color:#5b6b7c;font-size:13px;">신청 시각</td>
              <td style="padding:14px 18px;color:#14213d;font-size:13px;">${kst}</td>
            </tr>
          </table>
          <p style="margin-top:16px;font-size:12px;color:#98a4b3;text-align:center;">이 메일은 랜딩페이지 상담신청 폼에서 자동 발송되었습니다.</p>
        </div>
      `,
    });
  } catch (emailErr) {
    console.error('[consult] Email send error:', emailErr.message);
    // 이메일 실패해도 DB 저장은 됐으므로 성공으로 응답
  }

  return res.status(200).json({ ok: true });
};
