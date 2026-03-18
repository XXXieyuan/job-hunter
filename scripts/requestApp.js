'use strict';

const { PassThrough, Readable, Writable } = require('stream');

function makeRequestStream(body) {
  const payload = body ? Buffer.from(body) : null;
  let sent = false;

  return new Readable({
    read() {
      if (sent) {
        this.push(null);
        return;
      }

      sent = true;
      this.push(payload);
      this.push(null);
    }
  });
}

function invoke(app, options = {}) {
  return new Promise((resolve, reject) => {
    const method = options.method || 'GET';
    const url = options.url || '/';
    const headers = Object.fromEntries(
      Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value])
    );
    const body = options.body
      ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body))
      : '';

    if (body && !headers['content-length']) {
      headers['content-length'] = Buffer.byteLength(body);
    }

    const req = makeRequestStream(body);

    req.method = method;
    req.url = url;
    req.originalUrl = url;
    req.headers = headers;
    req.body = options.body;
    const socket = new PassThrough();
    socket.remoteAddress = '127.0.0.1';
    socket.encrypted = false;
    req.connection = socket;
    req.socket = socket;
    req.httpVersion = '1.1';
    req.get = (name) => req.headers[String(name).toLowerCase()];

    const chunks = [];
    const res = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    });

    res.statusCode = 200;
    res.headersSent = false;
    res.locals = {};
    res.setHeader = (name, value) => {
      res.headersSent = true;
      res._headers = res._headers || {};
      res._headers[String(name).toLowerCase()] = value;
    };
    res.getHeader = (name) => (res._headers || {})[String(name).toLowerCase()];
    res.removeHeader = (name) => {
      if (res._headers) {
        delete res._headers[String(name).toLowerCase()];
      }
    };
    res.writeHead = (statusCode, headersMap) => {
      res.statusCode = statusCode;
      for (const [name, value] of Object.entries(headersMap || {})) {
        res.setHeader(name, value);
      }
    };
    res.write = (chunk) => {
      if (chunk) {
        chunks.push(Buffer.from(chunk));
      }
      return true;
    };
    res.end = (chunk) => {
      if (chunk) {
        chunks.push(Buffer.from(chunk));
      }

      resolve({
        statusCode: res.statusCode,
        headers: res._headers || {},
        body: Buffer.concat(chunks).toString('utf8')
      });
    };

    app.handle(req, res, reject);
  });
}

module.exports = {
  invoke
};
