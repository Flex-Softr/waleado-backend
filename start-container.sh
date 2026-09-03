docker run -d \
  --name lw-backend \
  --restart unless-stopped \
  -v lw_wa_sessions:/app/.wa-sessions \
  -v lw_uploads:/app/uploads \
  --env-file .env \
  -p 5001:5001 \
  lw-backend:1.0