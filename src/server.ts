import { createApp } from './app';
import { loadConfig } from './config';
import { FakePaymentGateway } from './payment';
import { seedProducts } from './seed';
import { createStore } from './store';

const config = loadConfig();
const app = createApp({
  store: createStore(seedProducts()),
  config,
  payment: new FakePaymentGateway(config.paymentDelayMs),
});

app.listen(config.port, () => {
  console.log(`Checkout service listening on http://localhost:${config.port}`);
  const orders = config.nthOrder === 1 ? 'order' : `${config.nthOrder} orders`;
  console.log(`A ${config.discountPercent}% coupon unlocks after every ${orders}.`);
});
