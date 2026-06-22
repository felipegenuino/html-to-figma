#!/usr/bin/env node
/**
 * Relay WebSocket local — ponte entre a extensão (produtor) e o plugin do
 * Figma (consumidor) para capturas grandes que estouram o clipboard.
 *
 * Implementação sem dependências: handshake RFC 6455 + parser de frames sobre
 * o servidor http nativo. A última captura recebida fica em buffer para que o
 * plugin a receba mesmo conectando depois da extensão.
 *
 * Uso: `npm run relay` (na raiz) ou `node packages/relay/server.mjs`.
 * Porta configurável via H2F_RELAY_PORT (padrão 7341).
 */
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.H2F_RELAY_PORT) || 7341;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** @type {Set<import("node:net").Socket>} */
const clients = new Set();
let lastCapture = null;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(426, { "content-type": "text/plain" });
  res.end("Upgrade Required");
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  clients.add(socket);
  log(`cliente conectado (${clients.size} no total)`);

  // quem chega depois do produtor ainda recebe a última captura
  if (lastCapture) sendText(socket, lastCapture);

  attachReader(socket, (message) => {
    lastCapture = message;
    let n = 0;
    for (const other of clients) {
      if (other !== socket && !other.destroyed) {
        sendText(other, message);
        n++;
      }
    }
    log(`captura recebida (${fmtBytes(message.length)}) → ${n} cliente(s)`);
  });

  const drop = () => {
    if (clients.delete(socket)) log(`cliente saiu (${clients.size} restante(s))`);
  };
  socket.on("close", drop);
  socket.on("error", drop);
});

server.listen(PORT, () => {
  console.log(`h2f relay ouvindo em ws://localhost:${PORT}`);
  console.log("Aguardando a extensão e o plugin do Figma…");
});
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`Porta ${PORT} em uso. Defina H2F_RELAY_PORT para outra porta.`);
    process.exit(1);
  }
  throw e;
});

// ------------------------------------------------------------------ frames

/** Lê frames WebSocket de um socket, lidando com fragmentação TCP e continuação. */
function attachReader(socket, onMessage) {
  let buf = Buffer.alloc(0);
  let fragments = [];
  let fragOpcode = 0;

  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let frame;
    while ((frame = parseFrame(buf))) {
      buf = buf.subarray(frame.totalLength);
      handleFrame(frame);
    }
  });

  function handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) return void socket.end(); // close
    if (opcode === 0x9) return sendFrame(socket, 0xa, payload); // ping → pong
    if (opcode === 0xa) return; // pong
    // data: text (0x1), binary (0x2) ou continuação (0x0)
    if (opcode !== 0x0) {
      fragments = [];
      fragOpcode = opcode;
    }
    fragments.push(payload);
    if (fin) {
      const full = Buffer.concat(fragments);
      fragments = [];
      onMessage(full.toString("utf8"));
    }
  }
}

/** Retorna o frame decodificado ou null se ainda não chegou por completo. */
function parseFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    len = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }
  let maskKey = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  let payload = buf.subarray(offset, offset + len);
  if (masked) {
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
    payload = out;
  }
  return { fin, opcode, payload, totalLength: offset + len };
}

function sendText(socket, str) {
  sendFrame(socket, 0x1, Buffer.from(str, "utf8"));
}

/** Escreve um frame não-mascarado (servidor → cliente). */
function sendFrame(socket, opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  try {
    socket.write(Buffer.concat([header, payload]));
  } catch {
    /* socket fechado entre o check e o write */
  }
}

// ------------------------------------------------------------------- utils

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function log(msg) {
  const t = new Date().toLocaleTimeString();
  console.log(`[${t}] ${msg}`);
}
