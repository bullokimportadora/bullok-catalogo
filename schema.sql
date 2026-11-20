-- Esquema de la base de datos de pedidos y clientes de Bullok (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS clientes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre     TEXT DEFAULT '',
  razon      TEXT DEFAULT '',
  nit        TEXT DEFAULT '',
  cedula     TEXT DEFAULT '',
  tel        TEXT DEFAULT '',
  ciudad     TEXT DEFAULT '',
  direccion  TEXT DEFAULT '',
  vendedor   TEXT DEFAULT '',
  actualizado TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_cli_nit ON clientes(nit);
CREATE INDEX IF NOT EXISTS idx_cli_ced ON clientes(cedula);
CREATE INDEX IF NOT EXISTS idx_cli_tel ON clientes(tel);
CREATE INDEX IF NOT EXISTS idx_cli_nom ON clientes(nombre);

CREATE TABLE IF NOT EXISTS pedidos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  numero         TEXT DEFAULT '',
  fecha          TEXT DEFAULT '',
  cliente_nombre TEXT DEFAULT '',
  cliente_razon  TEXT DEFAULT '',
  cliente_tel    TEXT DEFAULT '',
  cliente_nit    TEXT DEFAULT '',
  cliente_cedula TEXT DEFAULT '',
  ciudad         TEXT DEFAULT '',
  direccion      TEXT DEFAULT '',
  vendedor       TEXT DEFAULT '',
  observaciones  TEXT DEFAULT '',
  total          INTEGER DEFAULT 0,
  items_json     TEXT DEFAULT '[]',
  payload_json   TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_ped_numero ON pedidos(numero);
CREATE INDEX IF NOT EXISTS idx_ped_nom ON pedidos(cliente_nombre);
