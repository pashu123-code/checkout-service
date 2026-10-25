import type { Product } from './store';

export function seedProducts(): Product[] {
  return [
    { id: 'p_tshirt', name: 'Cotton T-Shirt', priceCents: 1999, stock: 100, reserved: 0 },
    { id: 'p_mug', name: 'Ceramic Mug', priceCents: 1250, stock: 50, reserved: 0 },
    { id: 'p_hoodie', name: 'Zip Hoodie', priceCents: 4999, stock: 25, reserved: 0 },
    { id: 'p_cap', name: 'Baseball Cap', priceCents: 1599, stock: 40, reserved: 0 },
    { id: 'p_stickers', name: 'Sticker Pack', priceCents: 299, stock: 500, reserved: 0 },
    // Deliberately scarce, to make overselling easy to provoke.
    { id: 'p_sneakers', name: 'Limited Edition Sneakers', priceCents: 12999, stock: 2, reserved: 0 },
  ];
}
