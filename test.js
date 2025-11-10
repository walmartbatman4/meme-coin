/**
 * server.test.js — simple combined test file
 * Place this in the same folder as server.js
 * Run using:  npm test
 */

const request = require('supertest');
const { app, mergeTokens } = require('./server'); // <- export these from server.js

describe('mergeTokens()', () => {
  test('merges lists keeping higher liquidity', () => {
    const listA = [{ token_address: '1', liquidity_sol: 10, protocol: 'A' }];
    const listB = [{ token_address: '1', liquidity_sol: 20, protocol: 'B' }];

    const result = mergeTokens(listA, listB);
    expect(result.length).toBe(1);
    expect(result[0].liquidity_sol).toBe(20);
    expect(result[0].sources).toContain('A');
    expect(result[0].sources).toContain('B');
  });

  test('merges distinct tokens', () => {
    const listA = [{ token_address: '1', liquidity_sol: 5, protocol: 'A' }];
    const listB = [{ token_address: '2', liquidity_sol: 15, protocol: 'B' }];

    const result = mergeTokens(listA, listB);
    expect(result.length).toBe(2);
  });
});

describe('GET /health', () => {
  test('returns status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('tokens');
  });
});

describe('GET /api/tokens', () => {
  test('rejects invalid period', async () => {
    const res = await request(app).get('/api/tokens?period=invalid');
    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  test('returns paginated tokens data', async () => {
    const res = await request(app).get('/api/tokens?period=24hr&sortBy=volume&limit=1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
