import { keys } from './keys';

describe('redis keys', () => {
  it('wraps the product id in a cluster hash tag so all keys of a product share a slot', () => {
    expect(keys.stock('flash-sneaker')).toBe('flash:{flash-sneaker}:stock');
    expect(keys.reservation('flash-sneaker', 'r1')).toBe('flash:{flash-sneaker}:res:r1');
    expect(keys.user('flash-sneaker', 'u1')).toBe('flash:{flash-sneaker}:user:u1');
    expect(keys.pending('flash-sneaker')).toBe('flash:{flash-sneaker}:pending');
  });

  it('has a scan pattern matching all per-product keys', () => {
    expect(keys.productPattern('flash-sneaker')).toBe('flash:{flash-sneaker}:*');
  });
});
