import { createApp } from './app';
import { loadConfig } from './config';
import { seedProducts } from './seed';
import { createStore } from './store';

const config = loadConfig();
const app = createApp({ store: createStore(seedProducts()), config });

app.listen(config.port, () => {
  console.log(`Checkout service listening on http://localhost:${config.port}`);
  console.log(
    `Every ${config.nthOrder}th order unlocks a ${config.discountPercent}% coupon.`,
  );
});
