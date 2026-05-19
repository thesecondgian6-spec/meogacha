// Vercel Serverless Function — /api/callback
// Handles Discord OAuth token exchange securely (client secret stays server-side)

export default async function handler(req, res) {
  const { code, state, error } = req.query;

  const REDIRECT = 'https://meogacha.vercel.app';

  if (error) {
    return res.redirect(`${REDIRECT}/?error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return res.redirect(`${REDIRECT}/?error=no_code`);
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     '1506142424484024441',
        client_secret: 'ZqcGsjjT8vvGYO8vgJpRBhz3F-4WXbnO',
        grant_type:    'authorization_code',
        code:          code,
        redirect_uri:  'https://meogacha.vercel.app/callback',
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error('Token exchange failed:', err);
      return res.redirect(`${REDIRECT}/?error=token_exchange_failed`);
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // Get Discord user info
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!userRes.ok) {
      return res.redirect(`${REDIRECT}/?error=user_fetch_failed`);
    }

    const user = await userRes.json();

    const discordId = user.id;
    const username  = user.global_name || user.username;
    const avatar    = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/${parseInt(user.discriminator || '0') % 5}.png`;

    // Upsert player in Supabase
    await fetch('https://rfzljmzmycfxohthxroy.supabase.co/rest/v1/players', {
      method: 'POST',
      headers: {
        'apikey':       'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmemxqbXpteWNmeG9odGh4cm95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwNjk2MTEsImV4cCI6MjA5NDY0NTYxMX0.MLNFLhkbshYdrrV-MGCYctcSfuMbTQfk_xD84jbg4FY',
        'Authorization':'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJmemxqbXpteWNmeG9odGh4cm95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwNjk2MTEsImV4cCI6MjA5NDY0NTYxMX0.MLNFLhkbshYdrrV-MGCYctcSfuMbTQfk_xD84jbg4FY',
        'Content-Type': 'application/json',
        'Prefer':       'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        discord_id: discordId,
        username,
        avatar,
        coins:       1000,
        total_pulls: 0,
        pity_sr:     0,
        pity_ur:     0,
      }),
    });

    // Redirect back to game with user info in URL params
    // (token is kept minimal — just enough for the frontend to identify the user)
    const params = new URLSearchParams({
      token:      accessToken.slice(0, 16), // partial token, just for session reference
      discord_id: discordId,
      username,
      avatar,
      state:      state || '',
    });

    return res.redirect(`${REDIRECT}/?${params}`);

  } catch (err) {
    console.error('OAuth error:', err);
    return res.redirect(`${REDIRECT}/?error=server_error`);
  }
}
