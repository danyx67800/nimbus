import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { Sha256 } from '../web/src/sha256.js';

function digest(input: Buffer): string {
  const hasher = new Sha256();
  hasher.update(new Uint8Array(input));
  return hasher.hex();
}

test('incremental SHA-256 matches Node for empty, short and large inputs', () => {
  const samples = [
    Buffer.alloc(0),
    Buffer.from('abc'),
    Buffer.from('The quick brown fox jumps over the lazy dog'),
    Buffer.alloc(55, 0x61),
    Buffer.alloc(56, 0x62),
    Buffer.alloc(63, 0x63),
    Buffer.alloc(64, 0x64),
    Buffer.alloc(1000, 0x65),
    crypto.randomBytes(1024 * 1024 + 17),
  ];
  for (const sample of samples) {
    assert.equal(digest(sample), crypto.createHash('sha256').update(sample).digest('hex'));
  }
});

test('incremental updates with odd chunk sizes match one-shot hashing', () => {
  const sample = crypto.randomBytes(123_457);
  const expected = crypto.createHash('sha256').update(sample).digest('hex');
  const hasher = new Sha256();
  let offset = 0;
  const sizes = [1, 3, 7, 64, 1024, 13];
  let index = 0;
  while (offset < sample.length) {
    const size = sizes[index % sizes.length] ?? 1;
    hasher.update(new Uint8Array(sample.subarray(offset, Math.min(offset + size, sample.length))));
    offset += size;
    index += 1;
  }
  assert.equal(hasher.hex(), expected);
});
