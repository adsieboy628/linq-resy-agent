// Health check — public, no auth.
// Reports which env vars are set + which are missing, plus DB connectivity.
// Run from any browser / curl after pasting secrets to verify config.
//
//   GET https://eskqbzoisyrvybxyjmln.supabase.co/functions/v1/sniper-health
//
// Does not read secret values, only their presence (length + first 4 chars for sanity).

const REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY',
  'SNIPER_ENCRYPTION_KEY',
  'SNIPER_WEBHOOK_SECRET',
];

const OPTIONAL_TWILIO = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
  'SNIPER_OWNER_HANDLES',
];

interface VarStatus {
  name: string;
  set: boolean;
  length?: number;
  preview?: string;
  notes?: string;
}

function check(name: string): VarStatus {
  const v = Deno.env.get(name);
  if (!v) return { name, set: false };
  const status: VarStatus = { name, set: true, length: v.length };
  // Light sanity checks — never reveal full secret
  if (name === 'TWILIO_ACCOUNT_SID' && !v.startsWith('AC')) {
    status.notes = `expected to start with "AC" — got "${v.slice(0, 4)}"`;
  } else if (name === 'TWILIO_FROM_NUMBER' && !v.startsWith('+')) {
    status.notes = `expected E.164 format starting with "+" — got "${v.slice(0, 4)}"`;
  } else if (name === 'SNIPER_OWNER_HANDLES' && !v.startsWith('+')) {
    status.notes = `expected E.164 format starting with "+" — got "${v.slice(0, 4)}"`;
  } else if (name === 'SNIPER_ENCRYPTION_KEY' && v.length !== 64) {
    status.notes = `expected 64 hex chars — got ${v.length}`;
  } else if (name === 'SUPABASE_URL' && !v.startsWith('https://')) {
    status.notes = `expected to start with "https://" — got "${v.slice(0, 8)}"`;
  } else if (name === 'ANTHROPIC_API_KEY' && !v.startsWith('sk-ant-')) {
    status.notes = `expected to start with "sk-ant-" — got "${v.slice(0, 7)}"`;
  } else {
    // Safe preview: first 4 chars only
    status.preview = v.slice(0, 4) + '…';
  }
  return status;
}

async function checkDb(): Promise<{ ok: boolean; detail: string }> {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return { ok: false, detail: 'SUPABASE_URL/SERVICE_ROLE_KEY missing' };
  try {
    const res = await fetch(`${url}/rest/v1/sniper_meta?select=key&limit=1`, {
      headers: { 'apikey': key, 'Authorization': `Bearer ${key}` },
    });
    if (!res.ok) return { ok: false, detail: `db ping ${res.status}` };
    return { ok: true, detail: 'sniper_meta reachable' };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

Deno.serve(async (_req) => {
  const required = REQUIRED.map(check);
  const optional = OPTIONAL_TWILIO.map(check);
  const missingRequired = required.filter(v => !v.set).map(v => v.name);
  const dbStatus = await checkDb();
  const ok = missingRequired.length === 0 && dbStatus.ok && required.every(v => !v.notes);
  const twilioConfigured = OPTIONAL_TWILIO.every(n => Deno.env.get(n));

  return new Response(JSON.stringify({
    ok,
    summary: ok
      ? `✓ ready. web app live. ${twilioConfigured ? 'twilio sms also configured.' : 'twilio sms NOT configured (web-app-only mode).'}`
      : missingRequired.length > 0
        ? `✗ missing ${missingRequired.length} required env var(s): ${missingRequired.join(', ')}`
        : '✗ required env vars set but something looks off — check notes below',
    required,
    optional_twilio: optional,
    db: dbStatus,
  }, null, 2), {
    status: ok ? 200 : 500,
    headers: { 'content-type': 'application/json' },
  });
});
