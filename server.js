/**
 * FirmaES Escola — Servidor v2.1
 */

const express  = require('express');
const multer   = require('multer');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');
const fs       = require('fs');
const cors     = require('cors');
const https    = require('https');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT       = process.env.PORT     || 3000;
const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PASS  = process.env.ADMIN_PASS  || 'admin1234';
const RESEND_KEY  = process.env.RESEND_KEY  || '';
const FROM_EMAIL  = process.env.FROM_EMAIL  || 'onboarding@resend.dev';
const BASE_URL    = process.env.BASE_URL    || 'http://localhost:' + (process.env.PORT || 3000);

const COURSES = {
  '1r': { name: '1r ESO', classes: ['A','B','C','D','E'] },
  '2n': { name: '2n ESO', classes: ['A','B','C','D'] },
  '3r': { name: '3r ESO', classes: ['A','B','C','D'] },
  '4t': { name: '4t ESO', classes: ['A','B','C1','C2'] },
};

// Crea directori de dades si no existeix
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── DB ───────────────────────────────────────────────────────
const DB_FILE = path.join(DATA_DIR, 'db.json');

function loadDb() {
  let db = { classes: {} };
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      db = JSON.parse(raw);
      if (!db.classes) db.classes = {};
    }
  } catch(e) {
    console.error('Error carregant DB, reinicialitzant:', e.message);
    db = { classes: {} };
  }

  // Assegura que totes les classes del curs hi son
  let changed = false;
  for (const [courseId, course] of Object.entries(COURSES)) {
    for (const cls of course.classes) {
      const key = courseId + '-' + cls;
      if (!db.classes[key]) {
        db.classes[key] = {
          courseId, courseName: course.name, className: cls,
          pdfPath: null, pdfName: null, pdfVersion: 0,
          signers: [], active: false,
          createdAt: null, completedAt: null,
        };
        changed = true;
      }
    }
  }
  if (changed) saveDb(db);
  return db;
}

function saveDb(db) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
  catch(e) { console.error('Error guardant DB:', e.message); }
}

let db = loadDb();
console.log('DB carregada. Classes:', Object.keys(db.classes).join(', '));
console.log('BASE_URL:', BASE_URL);
// ── MULTER ───────────────────────────────────────────────────
function makeUploader(classKey) {
  return multer({
    storage: multer.diskStorage({
      destination: function(req, file, cb) {
        const dir = path.join(DATA_DIR, classKey || 'tmp');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: function(req, file, cb) {
        cb(null, 'doc_' + Date.now() + '.pdf');
      }
    }),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: function(req, file, cb) {
      if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
        cb(null, true);
      } else {
        cb(new Error('Només PDF'));
      }
    }
  });
}

// ── EMAIL ────────────────────────────────────────────────────
function sendEmail(to, toName, subject, html) {
  return new Promise((resolve) => {
    if (!RESEND_KEY) { console.log('RESEND_KEY no configurat, email omès'); return resolve(false); }
    if (!to) { console.log('Email omès: sense adreça per a', toName); return resolve(false); }

    const body = JSON.stringify({
      from: 'FirmaES <' + FROM_EMAIL + '>',
      to: [toName + ' <' + to + '>'],
      subject,
      html
    });

    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          console.log('Email enviat a', to);
          resolve(true);
        } else {
          console.error('Error Resend:', res.statusCode, data);
          resolve(false);
        }
      });
    });
    req.on('error', e => { console.error('Error email:', e.message); resolve(false); });
    req.write(body);
    req.end();
  });
}

function emailSigningTurn(session, signerIdx) {
  const signer   = session.signers[signerIdx];
  const signUrl  = BASE_URL + '/sign.html?class=' + session.classKey + '&signer=' + signer.id + '&token=' + signer.token;
  const prevDone = session.signers.filter(s => s.status === 'signed').map(s => s.name);
  const publicUrl = BASE_URL;

  const html = `<!DOCTYPE html>
<html lang="ca">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:32px 16px">
<tr><td align="center">
<table width="540" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)">
  <tr><td style="background:#0a1628;padding:24px 32px;border-bottom:3px solid #c9a227">
    <span style="font-family:Georgia,serif;font-size:20px;font-weight:bold;color:#f5f0e8">Firma<span style="color:#c9a227">ES</span></span>
  </td></tr>
  <tr><td style="padding:32px">
    <p style="font-size:13px;color:#6b7280;margin:0 0 6px">Hola ${signer.name},</p>
    <h2 style="font-family:Georgia,serif;font-size:22px;font-weight:300;color:#0a1628;margin:0 0 18px;line-height:1.2">
      Et toca <em style="color:#c9a227">signar</em> el document
    </h2>
    <div style="background:#f9f7f3;border:1px solid rgba(10,22,40,.08);border-radius:3px;padding:14px 18px;margin-bottom:20px">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#9ca3af;margin-bottom:6px">Document</div>
      <div style="font-size:15px;font-weight:500;color:#0a1628">📄 ${session.documentName}</div>
      <div style="margin-top:8px;font-size:12px;color:#6b7280">${session.courseName} — Classe ${session.className} &nbsp;·&nbsp; Torn ${signerIdx+1} de ${session.signers.length}</div>
    </div>
    ${prevDone.length > 0 ? '<div style="margin-bottom:16px;font-size:12px;color:#16a34a">✓ Ja han signat: ' + prevDone.join(', ') + '</div>' : ''}
    <div style="text-align:center;margin:24px 0">
      <a href="${signUrl}" style="display:inline-block;background:#c9a227;color:#0a1628;text-decoration:none;padding:13px 32px;border-radius:2px;font-weight:700;font-size:14px">
        Signar el document →
      </a>
    </div>
    <p style="font-size:11px;color:#9ca3af;line-height:1.6">
      Pots consultar l'estat general a: <a href="${publicUrl}" style="color:#c9a227">${publicUrl}</a><br>
      Si el botó no funciona, copia aquest enllaç: <span style="word-break:break-all">${signUrl}</span>
    </p>
  </td></tr>
  <tr><td style="background:#f9f7f3;padding:14px 32px;border-top:1px solid rgba(0,0,0,.06);font-size:11px;color:#9ca3af;text-align:center">
    FirmaES · Sistema de signatura digital · Missatge automàtic
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  return sendEmail(signer.email, signer.name, '📋 Et toca signar: ' + session.documentName, html);
}

function emailCompleted(session) {
  const downloadUrl = BASE_URL + '/api/pdf/' + session.classKey;
  const html = `<!DOCTYPE html>
<html lang="ca"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:32px 16px">
<tr><td align="center">
<table width="540" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:4px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)">
  <tr><td style="background:#0a1628;padding:24px 32px;border-bottom:3px solid #22c55e">
    <span style="font-family:Georgia,serif;font-size:20px;font-weight:bold;color:#f5f0e8">Firma<span style="color:#c9a227">ES</span></span>
  </td></tr>
  <tr><td style="padding:32px;text-align:center">
    <div style="font-size:3rem;margin-bottom:12px">✅</div>
    <h2 style="font-family:Georgia,serif;font-size:22px;font-weight:300;color:#0a1628;margin:0 0 8px">Document completat</h2>
    <p style="font-size:13px;color:#6b7280;margin:0 0 20px">
      El document <strong>${session.documentName}</strong> (${session.courseName} — ${session.className})<br>
      ha estat signat per tots els participants.
    </p>
    <a href="${downloadUrl}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:13px 28px;border-radius:2px;font-weight:600;font-size:14px">
      ⬇ Descarregar document final
    </a>
  </td></tr>
  <tr><td style="background:#f9f7f3;padding:14px 32px;border-top:1px solid rgba(0,0,0,.06);font-size:11px;color:#9ca3af;text-align:center">
    FirmaES · Missatge automàtic
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  // Envia a tots els signataris
  const promises = session.signers
    .filter(s => s.email)
    .map(s => sendEmail(s.email, s.name, '✅ Document signat: ' + session.documentName, html));
  return Promise.all(promises);
}

// ── HELPERS ──────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.adminToken;
  if (token !== ADMIN_PASS) return res.status(401).json({ error: 'No autoritzat' });
  next();
}

function getClass(classKey) {
  return db.classes[classKey] || null;
}

function currentSignerIdx(cls) {
  return cls.signers.findIndex(function(s) { return s.status === 'pending'; });
}

function sanitizeClass(cls, key) {
  return Object.assign({}, cls, {
    classKey: key,
    signers: cls.signers.map(function(s) {
      return { id: s.id, name: s.name, status: s.status, signedAt: s.signedAt };
    })
  });
}

// ── API ADMIN ────────────────────────────────────────────────

app.post('/api/admin/login', function(req, res) {
  if (req.body.password !== ADMIN_PASS) return res.status(401).json({ error: 'Contrasenya incorrecta' });
  res.json({ ok: true, token: ADMIN_PASS });
});

app.get('/api/admin/classes', requireAdmin, function(req, res) {
  const result = {};
  for (const [courseId, course] of Object.entries(COURSES)) {
    result[courseId] = {
      name: course.name,
      classes: course.classes.map(function(cls) {
        const key = courseId + '-' + cls;
        return sanitizeClass(db.classes[key], key);
      })
    };
  }
  res.json({ ok: true, courses: result });
});

// Puja PDF — multer processa, després validem
app.post('/api/admin/classes/:classKey/pdf', requireAdmin, function(req, res) {
  const classKey = req.params.classKey;
  const cls = getClass(classKey);

  // Valida la classe PRIMER
  if (!cls) {
    console.error('Classe no trobada:', classKey, '| Classes disponibles:', Object.keys(db.classes));
    return res.status(404).json({ error: 'Classe no trobada: ' + classKey });
  }

  // Ara processa el fitxer
  const uploader = makeUploader(classKey);
  uploader.single('pdf')(req, res, function(err) {
    if (err) {
      console.error('Error multer:', err.message);
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'Falta el PDF' });

    // Elimina PDF anterior
    if (cls.pdfPath && fs.existsSync(cls.pdfPath)) {
      try { fs.unlinkSync(cls.pdfPath); } catch(e) {}
    }

    cls.pdfPath    = req.file.path;
    cls.pdfName    = req.file.originalname || req.file.filename;
    cls.pdfVersion = 0;
    cls.createdAt  = new Date().toISOString();
    saveDb(db);

    console.log('PDF pujat per', classKey + ':', cls.pdfName);
    res.json({ ok: true, pdfName: cls.pdfName });
  });
});

app.post('/api/admin/classes/:classKey/signers', requireAdmin, function(req, res) {
  const cls = getClass(req.params.classKey);
  if (!cls) return res.status(404).json({ error: 'Classe no trobada' });
  const name  = (req.body.name || '').trim();
  const email = (req.body.email || '').trim();
  if (!name) return res.status(400).json({ error: 'Falta el nom' });

  const signer = { id: uuidv4(), name, email, status: 'pending', signedAt: null, token: uuidv4() };
  cls.signers.push(signer);
  saveDb(db);
  res.json({ ok: true, signer: { id: signer.id, name: signer.name, status: signer.status } });
});

app.put('/api/admin/classes/:classKey/signers/order', requireAdmin, function(req, res) {
  const cls = getClass(req.params.classKey);
  if (!cls) return res.status(404).json({ error: 'Classe no trobada' });
  const order = req.body.order;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'Falta order' });
  const reordered = order.map(function(id) { return cls.signers.find(function(s) { return s.id === id; }); }).filter(Boolean);
  cls.signers = reordered;
  saveDb(db);
  res.json({ ok: true });
});

app.delete('/api/admin/classes/:classKey/signers/:signerId', requireAdmin, function(req, res) {
  const cls = getClass(req.params.classKey);
  if (!cls) return res.status(404).json({ error: 'Classe no trobada' });
  const idx = cls.signers.findIndex(function(s) { return s.id === req.params.signerId; });
  if (idx < 0) return res.status(404).json({ error: 'Signatari no trobat' });
  cls.signers.splice(idx, 1);
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/admin/classes/:classKey/activate', requireAdmin, function(req, res) {
  const cls = getClass(req.params.classKey);
  if (!cls) return res.status(404).json({ error: 'Classe no trobada' });
  if (!cls.pdfPath) return res.status(400).json({ error: 'Primer puja un PDF' });
  if (cls.signers.length === 0) return res.status(400).json({ error: 'Primer afegeix signataris' });

  cls.active = !cls.active;
  if (cls.active) {
    cls.signers.forEach(function(s) { s.status = 'pending'; s.signedAt = null; });
    cls.pdfVersion = 0;
    cls.completedAt = null;
    saveDb(db);
    // Envia email al primer signatari
    const session = {
      classKey: req.params.classKey,
      documentName: cls.pdfName || 'Document',
      courseName: cls.courseName,
      className: cls.className,
      signers: cls.signers
    };
    emailSigningTurn(session, 0).catch(e => console.error('Email error:', e));
    res.json({ ok: true, active: cls.active });
  } else {
    saveDb(db);
    res.json({ ok: true, active: cls.active });
  }
});

app.post('/api/admin/classes/:classKey/reset', requireAdmin, function(req, res) {
  const cls = getClass(req.params.classKey);
  if (!cls) return res.status(404).json({ error: 'Classe no trobada' });
  cls.signers.forEach(function(s) { s.status = 'pending'; s.signedAt = null; });
  cls.pdfVersion = 0;
  cls.active = false;
  cls.completedAt = null;
  saveDb(db);
  res.json({ ok: true });
});

app.get('/api/admin/classes/:classKey/links', requireAdmin, function(req, res) {
  const cls = getClass(req.params.classKey);
  if (!cls) return res.status(404).json({ error: 'Classe no trobada' });
  const baseUrl = 'http://localhost:' + PORT;
  const links = cls.signers.map(function(s) {
    return {
      name: s.name,
      url: baseUrl + '/sign.html?class=' + req.params.classKey + '&signer=' + s.id + '&token=' + s.token,
      status: s.status,
    };
  });
  res.json({ ok: true, links });
});

// ── API PÚBLICA ──────────────────────────────────────────────

app.get('/api/public/courses', function(req, res) {
  const result = {};
  for (const [courseId, course] of Object.entries(COURSES)) {
    result[courseId] = {
      name: course.name,
      classes: course.classes.map(function(cls) {
        const key = courseId + '-' + cls;
        const c = db.classes[key];
        const signed = c.signers.filter(function(s) { return s.status === 'signed'; }).length;
        const currentIdx = currentSignerIdx(c);
        return {
          classKey: key, className: cls, courseName: course.name,
          active: c.active, pdfName: c.pdfName,
          totalSigners: c.signers.length, signedCount: signed,
          completed: c.active && c.signers.length > 0 && signed === c.signers.length,
          currentSigner: currentIdx >= 0 ? c.signers[currentIdx].name : null,
          signers: c.signers.map(function(s) {
            return { id: s.id, name: s.name, status: s.status, signedAt: s.signedAt };
          })
        };
      })
    };
  }
  res.json({ ok: true, courses: result });
});

app.get('/api/pdf/:classKey', function(req, res) {
  const cls = getClass(req.params.classKey);
  if (!cls || !cls.pdfPath) return res.status(404).json({ error: 'PDF no trobat' });
  if (!fs.existsSync(cls.pdfPath)) return res.status(404).json({ error: 'Fitxer no trobat' });
  const safeName = cls.courseName + '_' + cls.className + '_v' + cls.pdfVersion + '.pdf';
  res.download(cls.pdfPath, safeName);
});

app.get('/api/sign/:classKey/:signerId/:token', function(req, res) {
  const cls = getClass(req.params.classKey);
  if (!cls) return res.status(404).json({ error: 'Classe no trobada' });
  if (!cls.active) return res.status(400).json({ error: 'El procés de firma no està actiu' });

  const signer = cls.signers.find(function(s) {
    return s.id === req.params.signerId && s.token === req.params.token;
  });
  if (!signer) return res.status(403).json({ error: 'Enllaç no vàlid' });

  const myIdx      = cls.signers.findIndex(function(s) { return s.id === signer.id; });
  const currentIdx = currentSignerIdx(cls);
  const isMyTurn   = currentIdx === myIdx;

  res.json({
    ok: true, classKey: req.params.classKey,
    className: cls.className, courseName: cls.courseName,
    pdfName: cls.pdfName, pdfVersion: cls.pdfVersion,
    signer: { id: signer.id, name: signer.name, status: signer.status },
    isMyTurn, currentSignerName: currentIdx >= 0 ? cls.signers[currentIdx].name : null,
    signers: cls.signers.map(function(s) { return { name: s.name, status: s.status, signedAt: s.signedAt }; }),
    position: myIdx + 1, total: cls.signers.length,
  });
});

app.post('/api/sign/:classKey/:signerId/:token', function(req, res) {
  const classKey = req.params.classKey;
  const cls = getClass(classKey);
  if (!cls) return res.status(404).json({ error: 'Classe no trobada' });
  if (!cls.active) return res.status(400).json({ error: 'Procés no actiu' });

  const signer = cls.signers.find(function(s) {
    return s.id === req.params.signerId && s.token === req.params.token;
  });
  if (!signer) return res.status(403).json({ error: 'Enllaç no vàlid' });
  if (signer.status === 'signed') return res.status(400).json({ error: 'Ja has confirmat la firma' });

  const myIdx      = cls.signers.findIndex(function(s) { return s.id === signer.id; });
  const currentIdx = currentSignerIdx(cls);
  if (currentIdx !== myIdx) return res.status(400).json({ error: 'Encara no és el teu torn' });

  makeUploader(classKey).single('pdf')(req, res, function(err) {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Falta el PDF signat' });

    if (cls.pdfPath && fs.existsSync(cls.pdfPath)) {
      try { fs.unlinkSync(cls.pdfPath); } catch(e) {}
    }
    cls.pdfPath    = req.file.path;
    cls.pdfVersion++;
    signer.status  = 'signed';
    signer.signedAt= new Date().toISOString();

    const allSigned = cls.signers.every(function(s) { return s.status === 'signed'; });
    if (allSigned) cls.completedAt = new Date().toISOString();
    saveDb(db);

    const nextIdx    = currentSignerIdx(cls);
    const nextSigner = nextIdx >= 0 ? cls.signers[nextIdx] : null;
    console.log(signer.name + ' ha signat (' + cls.courseName + ' ' + cls.className + ')');

    // Emails automàtics
    const session = {
      classKey, documentName: cls.pdfName || 'Document',
      courseName: cls.courseName, className: cls.className,
      signers: cls.signers
    };
    if (allSigned) {
      emailCompleted(session).catch(e => console.error('Email completed error:', e));
    } else if (nextIdx >= 0) {
      emailSigningTurn(session, nextIdx).catch(e => console.error('Email turn error:', e));
    }

    res.json({ ok: true, allSigned, nextSigner: nextSigner ? { name: nextSigner.name } : null });
  });
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, function() {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║      FirmaES Escola — Servidor       ║');
  console.log('╠══════════════════════════════════════╣');
  console.log('║  http://localhost:' + PORT + '               ║');
  console.log('║  Admin: http://localhost:' + PORT + '/admin  ║');
  console.log('║  Pass:  ' + ADMIN_PASS + '                   ║');
  console.log('╚══════════════════════════════════════╝');
});
