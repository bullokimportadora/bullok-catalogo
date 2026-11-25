// Backend de pedidos, clientes e inventario de Bullok — Cloudflare Worker + D1
// Sirve los archivos estáticos (catálogo) y expone una API en /api/*

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, x-bullok-key',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });

const pad = (n) => 'BK-' + String(n).padStart(5, '0');

function clave(req) {
  const u = new URL(req.url);
  return req.headers.get('x-bullok-key') || u.searchParams.get('k') || '';
}
function autorizado(req, env) {
  return !!env.ADMIN_KEY && clave(req) === env.ADMIN_KEY;
}

// Stock inicial (sembrado una sola vez; no pisa las existencias ya guardadas)
const STOCK_INICIAL = {"BLK-013":6000,"BLK-014":6000,"BLK-018":6000,"BLK-410":48,"BLK-412":48,"BLK-413":32,"BLK-417":1000,"BLK-420":1400,"BLK-424":2160,"BLK-444":700,"GBA-B":300,"4V":1200,"DWS-JW-150":30,"DWS-JW-300":30,"DWS-JW-500":15,"SF-400":400,"73005":600,"BLK-344":1320,"BLK-490":6000,"WFM786454":1440,"TC04":480,"HM-109":800,"HM-67":800,"HM-61":800,"HM-55":800,"HM-1":800,"GD-12240":120,"GD1280":240,"DWS-P-150":50,"BLK-SQ23":1728,"BLK-SQ24":1728,"BLK-SQ22":1728,"BLK-SQ21":1728,"BLK-SQ20":1728,"BLK-SQ19":1728,"BLK-SQ18":1728,"BLK-SQ17":1728,"BLK-SQ16":1728,"BLK-SQ15":864,"BLK-SQ14":1728,"BLK-SQ13":1728,"BLK-GL8-2":1500,"BLK-GL8-1":1500,"BLK-GL8":1500,"BLK-489-4":1000,"BLK-489-3":1000,"BLK-489-2":1000,"BLK-489":1000,"BLK-489-1":1000,"BLK-423":2160,"BLK-422":4320,"BLK-419":2600,"BLK-418":2400,"BLK-411":48,"BLK-384":1500,"BLK-358":2000,"BLK-345":480,"BLK-066":100,"BLK-065":64,"10417":2880,"10045":800,"5511":180,"5014":480,"5012":480,"5010":400,"4807":480,"6-30":1320,"11401":40,"11402":80,"11411":30,"WX-PW02":60,"WX-PW03":60,"BLS-M503":60};

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady || !env.DB) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS stock (ref TEXT PRIMARY KEY, cantidad INTEGER NOT NULL DEFAULT 0, actualizado TEXT)`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS pedido_stock (numero TEXT PRIMARY KEY, aplicado INTEGER DEFAULT 0, despachado INTEGER DEFAULT 0, unidades_json TEXT, actualizado TEXT)`
  ).run();
  const now = new Date().toISOString();
  const stmts = [];
  for (const ref in STOCK_INICIAL) {
    stmts.push(
      env.DB.prepare(`INSERT OR IGNORE INTO stock (ref,cantidad,actualizado) VALUES (?,?,?)`).bind(ref, STOCK_INICIAL[ref], now)
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  schemaReady = true;
}

// Suma las unidades sueltas pedidas por referencia, leídas del payload (it[x][9])
function unidadesDePayload(b) {
  const it = (b && b.payload && b.payload.it) || (b && b.items) || [];
  const m = {};
  for (const x of it) {
    const ref = x && x[0];
    const u = Math.round(Number(x && x[9]) || 0);
    if (ref && u) m[ref] = (m[ref] || 0) + u;
  }
  return m;
}

// Aplica un cambio de stock por referencia. sign +1 devuelve, -1 descuenta.
async function aplicarStock(env, uds, sign) {
  const now = new Date().toISOString();
  const stmts = [];
  for (const ref in uds) {
    const d = sign * uds[ref];
    if (!d) continue;
    stmts.push(
      env.DB.prepare(`UPDATE stock SET cantidad = MAX(0, cantidad + ?), actualizado = ? WHERE ref = ?`).bind(d, now, ref)
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // Todo lo que no sea /api/ se sirve como archivo estático (catálogo)
    if (!p.startsWith('/api/')) {
      return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });
    }

    try {
      await ensureSchema(env);
      if (p === '/api/login' && req.method === 'POST') return await login(req, env);
      if (p === '/api/import' && req.method === 'POST') return await importarClientes(req, env);
      if (p === '/api/pedido' && req.method === 'POST') return await crearPedido(req, env);
      if (p === '/api/pedido' && req.method === 'GET') return await traerPedido(req, env);
      if (p === '/api/pedido/actualizar' && req.method === 'POST') return await actualizarPedido(req, env);
      if (p === '/api/pedido/eliminar' && req.method === 'POST') return await eliminarPedido(req, env);
      if (p === '/api/pedido/despachar' && req.method === 'POST') return await despacharPedido(req, env);
      if (p === '/api/pedidos' && req.method === 'GET') return await listarPedidos(req, env);
      if (p === '/api/clientes' && req.method === 'GET') return await buscarClientes(req, env);
      if (p === '/api/stock' && req.method === 'GET') return await traerStock(req, env);
      if (p === '/api/stock/ajustar' && req.method === 'POST') return await ajustarStock(req, env);
      return json({ ok: false, error: 'ruta no encontrada' }, 404);
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 500);
    }
  },
};

// --- Validar clave compartida (modo equipo) ---
async function login(req, env) {
  const b = await req.json().catch(() => ({}));
  if (env.ADMIN_KEY && b.key === env.ADMIN_KEY) return json({ ok: true });
  return json({ ok: false, error: 'clave incorrecta' }, 401);
}

// --- Crear/guardar un pedido (público: lo dispara el envío por WhatsApp) ---
async function crearPedido(req, env) {
  const b = await req.json();
  const c = b.cliente || {};
  const fecha = new Date().toISOString();

  const ins = await env.DB.prepare(
    `INSERT INTO pedidos
       (fecha,cliente_nombre,cliente_razon,cliente_tel,cliente_nit,cliente_cedula,
        ciudad,direccion,vendedor,observaciones,total,items_json,payload_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      fecha,
      c.nombre || '', c.razon || '', c.tel || '', c.nit || '', c.cedula || '',
      c.ciudad || '', c.direccion || '', c.vendedor || '',
      b.observaciones || '', Number(b.total) || 0,
      JSON.stringify(b.items || []),
      JSON.stringify(b.payload || b)
    )
    .run();

  const id = ins.meta.last_row_id;
  const numero = pad(id);
  await env.DB.prepare(`UPDATE pedidos SET numero=? WHERE id=?`).bind(numero, id).run();

  // Descontar inventario y dejar registro para poder devolver al eliminar
  const uds = unidadesDePayload(b);
  if (Object.keys(uds).length) await aplicarStock(env, uds, -1);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO pedido_stock (numero,aplicado,despachado,unidades_json,actualizado) VALUES (?,1,0,?,?)`
  ).bind(numero, JSON.stringify(uds), fecha).run();

  await upsertCliente(env, c, fecha);
  return json({ ok: true, numero, id });
}

// --- Guardar/actualizar el cliente para autollenado futuro ---
async function upsertCliente(env, c, fecha) {
  if (!(c.nombre || c.razon || c.tel || c.nit || c.cedula)) return;

  const find = async (col, val) => {
    if (!val) return null;
    return await env.DB.prepare(`SELECT id FROM clientes WHERE ${col}=? LIMIT 1`).bind(val).first();
  };
  const row = (await find('nit', c.nit)) || (await find('cedula', c.cedula)) || (await find('tel', c.tel));

  if (row) {
    await env.DB.prepare(
      `UPDATE clientes SET nombre=?,razon=?,nit=?,cedula=?,tel=?,ciudad=?,direccion=?,vendedor=?,actualizado=? WHERE id=?`
    )
      .bind(
        c.nombre || '', c.razon || '', c.nit || '', c.cedula || '', c.tel || '',
        c.ciudad || '', c.direccion || '', c.vendedor || '', fecha, row.id
      )
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO clientes (nombre,razon,nit,cedula,tel,ciudad,direccion,vendedor,actualizado)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
      .bind(
        c.nombre || '', c.razon || '', c.nit || '', c.cedula || '', c.tel || '',
        c.ciudad || '', c.direccion || '', c.vendedor || '', fecha
      )
      .run();
  }
}

// --- Importar clientes en lote (protegido con clave) ---
async function importarClientes(req, env) {
  if (!autorizado(req, env)) return json({ ok: false, error: 'no-auth' }, 401);
  const b = await req.json();
  const arr = Array.isArray(b.clientes) ? b.clientes : [];
  const fecha = new Date().toISOString();
  let n = 0;
  for (const c of arr) { await upsertCliente(env, c, fecha); n++; }
  return json({ ok: true, importados: n });
}

// --- Buscar clientes para autollenar (protegido con clave) ---
async function buscarClientes(req, env) {
  if (!autorizado(req, env)) return json({ ok: false, error: 'no-auth' }, 401);
  const q = (new URL(req.url).searchParams.get('q') || '').trim();
  if (q.length < 2) return json({ ok: true, clientes: [] });
  const like = '%' + q + '%';
  const r = await env.DB.prepare(
    `SELECT id,nombre,razon,nit,cedula,tel,ciudad,direccion,vendedor
       FROM clientes
      WHERE nombre LIKE ? OR razon LIKE ? OR nit LIKE ? OR cedula LIKE ? OR tel LIKE ?
      ORDER BY actualizado DESC LIMIT 12`
  ).bind(like, like, like, like, like).all();
  return json({ ok: true, clientes: r.results || [] });
}

// --- Listar / buscar pedidos (protegido con clave) ---
async function listarPedidos(req, env) {
  if (!autorizado(req, env)) return json({ ok: false, error: 'no-auth' }, 401);
  const q = (new URL(req.url).searchParams.get('q') || '').trim();
  let r;
  if (q) {
    const like = '%' + q + '%';
    r = await env.DB.prepare(
      `SELECT p.id,p.numero,p.fecha,p.cliente_nombre,p.ciudad,p.vendedor,p.total,
              COALESCE(ps.despachado,0) AS despachado
         FROM pedidos p LEFT JOIN pedido_stock ps ON ps.numero=p.numero
        WHERE p.numero LIKE ? OR p.cliente_nombre LIKE ? OR p.cliente_tel LIKE ? OR p.cliente_nit LIKE ?
        ORDER BY p.id DESC LIMIT 80`
    ).bind(like, like, like, like).all();
  } else {
    r = await env.DB.prepare(
      `SELECT p.id,p.numero,p.fecha,p.cliente_nombre,p.ciudad,p.vendedor,p.total,
              COALESCE(ps.despachado,0) AS despachado
         FROM pedidos p LEFT JOIN pedido_stock ps ON ps.numero=p.numero
        ORDER BY p.id DESC LIMIT 80`
    ).all();
  }
  return json({ ok: true, pedidos: r.results || [] });
}

// --- Actualizar un pedido existente (protegido con clave) ---
async function actualizarPedido(req, env) {
  if (!autorizado(req, env)) return json({ ok: false, error: 'no-auth' }, 401);
  const b = await req.json();
  const numero = (b.numero || '').trim();
  if (!numero) return json({ ok: false, error: 'falta numero' }, 400);
  const row = await env.DB.prepare(`SELECT id FROM pedidos WHERE numero=? LIMIT 1`).bind(numero).first();
  if (!row) return json({ ok: false, error: 'no existe' }, 404);
  const c = b.cliente || {};
  await env.DB.prepare(
    `UPDATE pedidos SET cliente_nombre=?,cliente_razon=?,cliente_tel=?,cliente_nit=?,cliente_cedula=?,
       ciudad=?,direccion=?,vendedor=?,observaciones=?,total=?,items_json=?,payload_json=? WHERE id=?`
  )
    .bind(
      c.nombre || '', c.razon || '', c.tel || '', c.nit || '', c.cedula || '',
      c.ciudad || '', c.direccion || '', c.vendedor || '',
      b.observaciones || '', Number(b.total) || 0,
      JSON.stringify(b.items || []),
      JSON.stringify(b.payload || b),
      row.id
    )
    .run();

  // Ajustar inventario por la diferencia (nuevo - viejo), si el pedido descontó y no está despachado
  const nuevo = unidadesDePayload(b);
  const ps = await env.DB.prepare(`SELECT aplicado,despachado,unidades_json FROM pedido_stock WHERE numero=?`).bind(numero).first();
  const ahora = new Date().toISOString();
  if (ps && ps.aplicado && !ps.despachado) {
    const viejo = JSON.parse(ps.unidades_json || '{}');
    const diff = {};
    const refs = new Set([...Object.keys(viejo), ...Object.keys(nuevo)]);
    refs.forEach((r) => { const d = (nuevo[r] || 0) - (viejo[r] || 0); if (d) diff[r] = d; });
    if (Object.keys(diff).length) await aplicarStock(env, diff, -1);
    await env.DB.prepare(`UPDATE pedido_stock SET unidades_json=?, actualizado=? WHERE numero=?`).bind(JSON.stringify(nuevo), ahora, numero).run();
  } else if (!ps) {
    await env.DB.prepare(`INSERT OR REPLACE INTO pedido_stock (numero,aplicado,despachado,unidades_json,actualizado) VALUES (?,0,0,?,?)`).bind(numero, JSON.stringify(nuevo), ahora).run();
  }
  return json({ ok: true, numero });
}

// --- Eliminar un pedido (protegido con clave) ---
async function eliminarPedido(req, env) {
  if (!autorizado(req, env)) return json({ ok: false, error: 'no-auth' }, 401);
  const b = await req.json();
  const numero = (b.numero || '').trim();
  if (!numero) return json({ ok: false, error: 'falta numero' }, 400);

  // Devolver inventario si el pedido descontó y no está despachado
  const ps = await env.DB.prepare(`SELECT aplicado,despachado,unidades_json FROM pedido_stock WHERE numero=?`).bind(numero).first();
  let devuelto = false;
  if (ps && ps.aplicado && !ps.despachado) {
    const uds = JSON.parse(ps.unidades_json || '{}');
    if (Object.keys(uds).length) await aplicarStock(env, uds, +1);
    devuelto = true;
  }
  await env.DB.prepare(`DELETE FROM pedido_stock WHERE numero=?`).bind(numero).run();
  await env.DB.prepare(`DELETE FROM pedidos WHERE numero=?`).bind(numero).run();
  return json({ ok: true, numero, devuelto });
}

// --- Marcar un pedido como despachado (ya no devuelve inventario si se elimina) ---
async function despacharPedido(req, env) {
  if (!autorizado(req, env)) return json({ ok: false, error: 'no-auth' }, 401);
  const b = await req.json();
  const numero = (b.numero || '').trim();
  if (!numero) return json({ ok: false, error: 'falta numero' }, 400);
  const val = b.despachado === false ? 0 : 1;
  const ahora = new Date().toISOString();
  const ps = await env.DB.prepare(`SELECT numero FROM pedido_stock WHERE numero=?`).bind(numero).first();
  if (ps) {
    await env.DB.prepare(`UPDATE pedido_stock SET despachado=?, actualizado=? WHERE numero=?`).bind(val, ahora, numero).run();
  } else {
    await env.DB.prepare(`INSERT OR REPLACE INTO pedido_stock (numero,aplicado,despachado,unidades_json,actualizado) VALUES (?,0,?,?,?)`).bind(numero, val, '{}', ahora).run();
  }
  return json({ ok: true, numero, despachado: val });
}

// --- Traer un pedido completo para reimprimir (protegido con clave) ---
async function traerPedido(req, env) {
  if (!autorizado(req, env)) return json({ ok: false, error: 'no-auth' }, 401);
  const numero = (new URL(req.url).searchParams.get('numero') || '').trim();
  const r = await env.DB.prepare(
    `SELECT numero,fecha,payload_json FROM pedidos WHERE numero=? LIMIT 1`
  ).bind(numero).first();
  if (!r) return json({ ok: false, error: 'no existe' }, 404);
  return json({ ok: true, numero: r.numero, fecha: r.fecha, payload: JSON.parse(r.payload_json || '{}') });
}

// --- Traer el inventario vivo (público: la página lo usa para topar cantidades) ---
async function traerStock(req, env) {
  const r = await env.DB.prepare(`SELECT ref,cantidad FROM stock`).all();
  const m = {};
  (r.results || []).forEach((x) => { m[x.ref] = x.cantidad; });
  return json({ ok: true, stock: m });
}

// --- Ajustar stock a mano / recargar inventario (protegido con clave) ---
// body: { stock: {ref: cantidad, ...}, modo: 'set' | 'sumar' }
async function ajustarStock(req, env) {
  if (!autorizado(req, env)) return json({ ok: false, error: 'no-auth' }, 401);
  const b = await req.json();
  const s = b.stock || {};
  const modo = b.modo === 'sumar' ? 'sumar' : 'set';
  const now = new Date().toISOString();
  const stmts = [];
  for (const ref in s) {
    const v = Math.round(Number(s[ref]) || 0);
    if (modo === 'sumar') {
      stmts.push(env.DB.prepare(`INSERT INTO stock (ref,cantidad,actualizado) VALUES (?,?,?) ON CONFLICT(ref) DO UPDATE SET cantidad=MAX(0,cantidad+?), actualizado=?`).bind(ref, Math.max(0, v), now, v, now));
    } else {
      stmts.push(env.DB.prepare(`INSERT INTO stock (ref,cantidad,actualizado) VALUES (?,?,?) ON CONFLICT(ref) DO UPDATE SET cantidad=?, actualizado=?`).bind(ref, Math.max(0, v), now, Math.max(0, v), now));
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return json({ ok: true, n: Object.keys(s).length, modo });
}
