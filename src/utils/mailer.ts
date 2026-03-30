import nodemailer from 'nodemailer';

export async function sendErrorEmail(errorMessage: string): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? 'smtp.office365.com',
    port: parseInt(process.env.SMTP_PORT ?? '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });

  const mailOptions = {
    from: process.env.MAIL_FROM ?? 'urata@texhnolyze.biz',
    to: process.env.MAIL_TO ?? 'urata@ark-pc.co.jp',
    cc: process.env.MAIL_CC ?? 'k_ishii@ark-pc.co.jp',
    subject: 'クロールエラー',
    text: [
      'クロール中に予期せぬエラーが発生しました。',
      '※本間さん用クローラー',
      '',
      'システム管理者に修正を依頼してください。',
      '',
      'エラー詳細:',
      errorMessage,
    ].join('\n'),
  };

  await transporter.sendMail(mailOptions);
  console.log('[Mail] エラーメール送信完了');
}
