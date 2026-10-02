export function hashSeed(value: string | number): number {
  const text = String(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export class SeededRandom {
  #state: number;

  constructor(seed: string | number) {
    this.#state = hashSeed(seed) || 0x6d2b79f5;
  }

  next(): number {
    let value = this.#state += 0x6d2b79f5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  integer(minimum: number, maximumInclusive: number): number {
    if (!Number.isInteger(minimum) || !Number.isInteger(maximumInclusive) || maximumInclusive < minimum) {
      throw new Error("Invalid seeded integer range");
    }
    return minimum + Math.floor(this.next() * (maximumInclusive - minimum + 1));
  }

  shuffle<T>(values: readonly T[]): T[] {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const other = this.integer(0, index);
      [result[index], result[other]] = [result[other]!, result[index]!];
    }
    return result;
  }
}
