// Backend de pedidos y clientes de Bullok — Cloudflare Worker + D1
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
      if (p === '/api/login' && req.method === 'POST') return await login(req, env);
      if (p === '/api/pedido' && req.method === 'POST') return await crearPedido(req, env);
      if (p === '/api/pedido' && req.method === 'GET') return await traerPedido(req, env);
      if (p === '/api/pedidos' && req.method === 'GET') return await listarPedidos(req, env);
      if (p === '/api/clientes' && req.method === 'GET') return await buscarClientes(req, env);
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
  // Se identifica al cliente por NIT, luego cédula, luego teléfono
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
      `SELECT id,numero,fecha,cliente_nombre,ciudad,vendedor,total
         FROM pedidos
        WHERE numero LIKE ? OR cliente_nombre LIKE ? OR cliente_tel LIKE ? OR cliente_nit LIKE ?
        ORDER BY id DESC LIMIT 80`
    ).bind(like, like, like, like).all();
  } else {
    r = await env.DB.prepare(
      `SELECT id,numero,fecha,cliente_nombre,ciudad,vendedor,total
         FROM pedidos ORDER BY id DESC LIMIT 80`
    ).all();
  }
  return json({ ok: true, pedidos: r.results || [] });
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
