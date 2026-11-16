import { app } from './app.mjs';

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Listening on http://localhost:${port}`);
  console.log('POST /orders/:orderId/pay   {"amount": 150000}');
  console.log('POST /webhooks/primary      (provider webhooks)');
});
