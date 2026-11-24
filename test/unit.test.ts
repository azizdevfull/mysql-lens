import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTableQuery, parseTableQuery } from '../src/query/tableQuery';

const p = (sql: string) => parseTableQuery(sql, 'shop_db', 'shops', 200);

test('parseTableQuery: simple table queries stay editable', () => {
  assert.deepEqual(p('SELECT * FROM shops'), { filter: '', sort: null, pageSize: 200, page: 0 });
  assert.deepEqual(p('select * from `shops` limit 100'), { filter: '', sort: null, pageSize: 100, page: 0 });
  assert.deepEqual(p('SELECT * FROM shop_db.shops WHERE user_id = 294 ORDER BY created_at DESC LIMIT 50 OFFSET 100;'), {
    filter: 'user_id = 294',
    sort: { column: 'created_at', dir: 'desc' },
    pageSize: 50,
    page: 2,
  });
  assert.deepEqual(p('SELECT * FROM shops LIMIT 40, 20'), { filter: '', sort: null, pageSize: 20, page: 2 });
  assert.deepEqual(p("SELECT * FROM shops WHERE name LIKE '%order by%' AND id > 1"), {
    filter: "name LIKE '%order by%' AND id > 1",
    sort: null,
    pageSize: 200,
    page: 0,
  });
  assert.deepEqual(p('-- comment\nSELECT * FROM shops\nWHERE id IN (1,2)\nORDER BY `name`'), {
    filter: 'id IN (1,2)',
    sort: { column: 'name', dir: 'asc' },
    pageSize: 200,
    page: 0,
  });
});

test('parseTableQuery: anything else is a custom query', () => {
  assert.equal(p('SELECT id, name FROM shops'), null);
  assert.equal(p('SELECT * FROM users'), null);
  assert.equal(p('SELECT * FROM shops s JOIN users u ON u.id = s.user_id'), null);
  assert.equal(p('SELECT * FROM shops WHERE 1 GROUP BY user_id'), null);
  assert.equal(p('SELECT * FROM shops ORDER BY a, b'), null);
  assert.equal(p('UPDATE shops SET name = 1'), null);
  assert.equal(p('SELECT * FROM shops LIMIT 0'), null);
});

test('buildTableQuery round-trips through parseTableQuery', () => {
  const states = [
    { page: 0, pageSize: 200, sort: null, filter: '' },
    { page: 3, pageSize: 50, sort: { column: 'created_at', dir: 'desc' as const }, filter: "status = 'active'" },
  ];
  for (const s of states) assert.deepEqual(p(buildTableQuery('shops', s)), s);
  assert.equal(buildTableQuery('order items', { page: 0, pageSize: 10, sort: { column: 'status', dir: 'asc' }, filter: '' }), 'SELECT * FROM `order items` ORDER BY `status` ASC LIMIT 10');
  assert.equal(buildTableQuery('shops', states[1]), "SELECT * FROM shops WHERE status = 'active' ORDER BY created_at DESC LIMIT 50 OFFSET 150");
});
