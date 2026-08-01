docker run -d \
  --name lw-backend \
  --env-file .env \
  -p 5001:5001 \
  lw-backend:1.0