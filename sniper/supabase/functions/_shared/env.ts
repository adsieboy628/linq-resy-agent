function req(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function opt(name: string): string {
  return Deno.env.get(name) || '';
}

export const env = {
  // Always required
  supabaseUrl: req('SUPABASE_URL'),
  supabaseServiceKey: req('SUPABASE_SERVICE_ROLE_KEY'),
  anthropicApiKey: req('ANTHROPIC_API_KEY'),
  credentialEncryptionKey: req('SNIPER_ENCRYPTION_KEY'),
  webhookSecret: req('SNIPER_WEBHOOK_SECRET'),

  // Optional — only needed if you're using the Twilio SMS path. Web app doesn't.
  twilioAccountSid: opt('TWILIO_ACCOUNT_SID'),
  twilioAuthToken: opt('TWILIO_AUTH_TOKEN'),
  twilioFromNumber: opt('TWILIO_FROM_NUMBER'),
  ownerHandles: opt('SNIPER_OWNER_HANDLES').split(',').map(s => s.trim()).filter(Boolean),

  // Resy public key — always defaulted
  resyApiKey: Deno.env.get('RESY_API_KEY') || 'VbWk7s3L4KiK5fzlO7JD3Q5EYolJI7n5',
};
