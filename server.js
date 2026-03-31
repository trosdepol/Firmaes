/**
 * FirmaES Escola — Servidor
 * 
 * Estructura: 4 cursos (1r,2n,3r,4t) amb classes (A,B,C,D,E...)
 * Cada classe té: un PDF + una llista de signataris en ordre
 * El PDF va passant d'un signatari al següent
 */

const express  = require('express');
const multer   = require('multer');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');
const fs       = require('fs');
const cors     = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── CONFIG ──────────────────────────────────────────────────
const PORT     = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin1234';

const COURSES = {
  '1r': { name: '1r ESO', classes: ['A','B','C','D','E'] },
  '2n': { name: '2n ESO', classes: ['A','B','C','D'] },
  '3r': { name: '3r ESO', classes: ['A','B','C','D'] },
  '4t': { name: '4t ESO', classes: ['A','B','C1','C2'] },
};

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── DADES ───────────────────────────────────────────────────
const DB_FILE = path.join(DATA_DIR, 'db.json');

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch(e) { console.error('Error carregant DB:', e.message); }
  // Inicialitza estructura buida
  const db = { classes: {} };
  for (const [courseId, course] of Object.entries(COURSES)) {
    for (const cls of course.classes) {
      const key = `${courseId}-${cls}`;
      db.classes[key] = {
        courseId, courseName: course.name, className: cls,
        pdfPath: null, pdfName: null, pdfVersion: 0,
        signers: [],   // [{id, name, status:'pending'|'signed', signedAt, token}]
        active: false, // true quan l'admin ha activat el procés
        createdAt: null, completedAt: null,
      };
    }
  }
  saveDb(db);
  return db;
}

function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let db = loadDb();

// ── MULTER ──────────────────────────────────────────────────
function makeUploader(subfolder) {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(DATA_DIR, subfolder || req.params.classKey || 'tmp');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => cb(null, `doc_${Date.now()}.pdf`)
    }),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (file.mimetype === 'application/pdf') cb(null, true);
      else cb(new Error('Només PDF'));
    }
  });
}

// ── MIDDLEWARE ADMIN ─────────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.adminToken;
  if (token !== ADMIN_PASS) return res.status(401).json({ error: 'No autoritzat' });
  next();
}

// ── HELPERS ──────────────────────────────────────────────────
function getClass(classKey) {
  const cls = db.classes[classKey];
  if (!cls) return null;
  return cls;
}

function currentSignerIdx(cls) {
  return cls.signers.findIndex(s => s.status === 'pending');
}

function sanitizeClass(cls) {
  return {
    ...cls,
    signers: cls.signers.map(s => ({ ...s, token: undefined }))
  };
}

// ── API ADMIN ────────────────────────────────────────────────

// Login admin (simple)
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASS) return res.status(401).json({ error: 'Contrasenya incorrecta' });
  res.json({ ok: true, token: ADMIN_PASS });
});

// Llista totes les classes
app.get('/api/admin/classes', requireAdmin, (req, res) => {
  const result = {};
  for (const [courseId, course] of Object.entries(COURSES)) {
    result[courseId] = {
      name: course.name,
      classes: course.classes.map(cls => {
        const key = `${courseId}-${cls}`;
        return sanitizeClass(db.classes[key]);
      })
    };
  }
  res.json({ ok: true, courses: result });
});

// Puja PDF per a una classe
app.post('/api/admin/classes/:classKey/pdf',
  requireAdmin,
  (req, res, next) => makeUploader(req.params.classKey).single('pdf')(req, res, next),
  (req, res) => {
    const cls = getClass(req.params.classKey);
    if (!cls) return res.status(404).json({ error: 'Classe no trobada' });
    if (!req.file) return res.status(400).json({ error: 'Falta el PDF' });

    // Elimina PDF anterior si existia
    if (cls.pdfPath && fs.existsSync(cls.pdfPath)) {
      try { fs.unlinkSync(cls.pdfPath); } catch(e) {}
    }

    cls.pdfPath = req.file.path;
    cls.pdfName = req.file.originalname || req.file.filename;
    cls.pdfVersion = 0;
    cls.createdAt = new Date().toISOString();
    saveDb(db);

    console.log(`📄 PDF pujat per ${req.params.classKey}: ${cls.pdfName}`);
    res.json({ ok: true, pdfName: cls.pdfName });
  }
);

// Afegeix signatari a una classe
app.post('/api/admin/classes/:classKey/signers', requireAdmin, (req, res) => {
  const cls = getClass(req.params.classKey);
  if (!cls) return res.status(404).json({ error: 'Classe no trobada' });

  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Falta el nom' });

  const signer = {
    id: uuidv4(),
    name: name.trim(),
    status: 'pending',
    signedAt: null,
    token: uuidv4(),
  };
  cls.signers.push(signer);
  saveDb(db);
  res.json({ ok: true, signer: { ...signer, token: undefined } });
});

// Reordena signataris (drag & drop)
app.put('/api/admin/classes/:classKey/signers/order', requireAdmin, (req, res) => {
  const cls = getClass(req.params.classKey);
  if (!cls) return res.status(404).json({ error: 'Classe no trobada' });

  const { order } = req.body; // array d'ids en nou ordre
  if (!Array.isArray(order)) return res.status(400).json({ error: 'Falta order' });

  const reordered = order.map(id => cls.signers.find(s => s.id === id)).filter(Boolean);
  if (reordered.length !== cls.signers.length) return res.status(400).json({ error: 'IDs incorrectes' });

  cls.signers = reordered;
  saveDb(db);
  res.json({ ok: true });
});

// Elimina signatari
app.delete('/api/admin/classes/:classKey/signers/:signerId', requireAdmin, (req, res) => {
  const cls = getClass(req.params.classKey);
  if (!cls) return res.status(404).json({ error: 'Classe no trobada' });

  const idx = cls.signers.findIndex(s => s.id === req.params.signerId);
  if (idx < 0) return res.status(404).json({ error: 'Signatari no trobat' });

  cls.signers.splice(idx, 1);
  saveDb(db);
  res.json({ ok: true });
});

// Activa / desactiva procés de firma
app.post('/api/admin/classes/:classKey/activate', requireAdmin, (req, res) => {
  const cls = getClass(req.params.classKey);
  if (!cls) return res.status(404).json({ error: 'Classe no trobada' });
  if (!cls.pdfPath) return res.status(400).json({ error: 'Primer puja un PDF' });
  if (cls.signers.length === 0) return res.status(400).json({ error: 'Primer afegeix signataris' });

  cls.active = !cls.active;
  if (cls.active) {
    // Reset de signatures si es reactiva
    cls.signers.forEach(s => { s.status = 'pending'; s.signedAt = null; });
    cls.pdfVersion = 0;
    cls.completedAt = null;
  }
  saveDb(db);
  res.json({ ok: true, active: cls.active });
});

// Reset complet d'una classe
app.post('/api/admin/classes/:classKey/reset', requireAdmin, (req, res) => {
  const cls = getClass(req.params.classKey);
  if (!cls) return res.status(404).json({ error: 'Classe no trobada' });

  cls.signers.forEach(s => { s.status = 'pending'; s.signedAt = null; });
  cls.pdfVersion = 0;
  cls.active = false;
  cls.completedAt = null;
  saveDb(db);
  res.json({ ok: true });
});

// ── API PÚBLICA ──────────────────────────────────────────────

// Vista pública de tots els cursos
app.get('/api/public/courses', (req, res) => {
  const result = {};
  for (const [courseId, course] of Object.entries(COURSES)) {
    result[courseId] = {
      name: course.name,
      classes: course.classes.map(cls => {
        const key = `${courseId}-${cls}`;
        const c = db.classes[key];
        const signed = c.signers.filter(s => s.status === 'signed').length;
        return {
          classKey: key,
          className: cls,
          courseName: course.name,
          active: c.active,
          pdfName: c.pdfName,
          totalSigners: c.signers.length,
          signedCount: signed,
          completed: c.active && c.signers.length > 0 && signed === c.signers.length,
          currentSigner: (() => {
            const idx = currentSignerIdx(c);
            return idx >= 0 ? c.signers[idx].name : null;
          })(),
          signers: c.signers.map(s => ({
            id: s.id,
            name: s.name,
            status: s.status,
            signedAt: s.signedAt,
          }))
        };
      })
    };
  }
  res.json({ ok: true, courses: result });
});

// Info d'una classe pel signatari (via token)
app.get('/api/sign/:classKey/:signerId/:token', (req, res) => {
  const cls = getClass(req.params.classKey);
  if (!cls) return res.status(404).json({ error: 'Classe no trobada' });
  if (!cls.active) return res.status(400).json({ error: 'El procés de firma no està actiu' });

  const signer = cls.signers.find(s => s.id === req.params.signerId && s.token === req.params.token);
  if (!signer) return res.status(403).json({ error: 'Enllaç no vàlid' });

  const currentIdx = currentSignerIdx(cls);
  const myIdx = cls.signers.findIndex(s => s.id === signer.id);
  const isMyTurn = currentIdx === myIdx;

  res.json({
    ok: true,
    classKey: req.params.classKey,
    className: cls.className,
    courseName: cls.courseName,
    pdfName: cls.pdfName,
    pdfVersion: cls.pdfVersion,
    signer: { id: signer.id, name: signer.name, status: signer.status },
    isMyTurn,
    currentSignerName: currentIdx >= 0 ? cls.signers[currentIdx].name : null,
    signers: cls.signers.map(s => ({ name: s.name, status: s.status, signedAt: s.signedAt })),
    position: myIdx + 1,
    total: cls.signers.length,
  });
});

// Descarrega el PDF actual
app.get('/api/pdf/:classKey', (req, res) => {
  const cls = getClass(req.params.classKey);
  if (!cls || !cls.pdfPath) return res.status(404).json({ error: 'PDF no trobat' });
  if (!fs.existsSync(cls.pdfPath)) return res.status(404).json({ error: 'Fitxer no trobat' });

  const safeName = `${cls.courseName}_${cls.className}_v${cls.pdfVersion}.pdf`;
  res.download(cls.pdfPath, safeName);
});

// Puja PDF signat + confirma firma
app.post('/api/sign/:classKey/:signerId/:token',
  (req, res, next) => makeUploader(req.params.classKey).single('pdf')(req, res, next),
  (req, res) => {
    const cls = getClass(req.params.classKey);
    if (!cls) return res.status(404).json({ error: 'Classe no trobada' });
    if (!cls.active) return res.status(400).json({ error: 'Procés no actiu' });

    const signer = cls.signers.find(s => s.id === req.params.signerId && s.token === req.params.token);
    if (!signer) return res.status(403).json({ error: 'Enllaç no vàlid' });
    if (signer.status === 'signed') return res.status(400).json({ error: 'Ja has confirmat la firma' });

    const currentIdx = currentSignerIdx(cls);
    const myIdx = cls.signers.findIndex(s => s.id === signer.id);
    if (currentIdx !== myIdx) return res.status(400).json({ error: 'Encara no és el teu torn' });

    if (!req.file) return res.status(400).json({ error: 'Falta el PDF signat' });

    // Substitueix el PDF actual pel signat
    if (cls.pdfPath && fs.existsSync(cls.pdfPath)) {
      try { fs.unlinkSync(cls.pdfPath); } catch(e) {}
    }
    cls.pdfPath = req.file.path;
    cls.pdfVersion++;

    // Marca com a signat
    signer.status = 'signed';
    signer.signedAt = new Date().toISOString();

    // Comprova si tots han signat
    const allSigned = cls.signers.every(s => s.status === 'signed');
    if (allSigned) {
      cls.completedAt = new Date().toISOString();
    }

    saveDb(db);

    const nextIdx = currentSignerIdx(cls);
    const nextSigner = nextIdx >= 0 ? cls.signers[nextIdx] : null;

    console.log(`✅ ${signer.name} ha signat (${cls.courseName} ${cls.className})`);
    if (nextSigner) console.log(`➡️  Torn de: ${nextSigner.name}`);
    else console.log(`🎉 Tots han signat! (${cls.courseName} ${cls.className})`);

    res.json({
      ok: true,
      allSigned,
      nextSigner: nextSigner ? { name: nextSigner.name } : null,
      message: allSigned ? 'Tots han signat!' : `Torn de ${nextSigner?.name}`
    });
  }
);

// ── GENERACIÓ D'ENLLAÇOS PER ADMIN ──────────────────────────
app.get('/api/admin/classes/:classKey/links', requireAdmin, (req, res) => {
  const cls = getClass(req.params.classKey);
  if (!cls) return res.status(404).json({ error: 'Classe no trobada' });

  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  const links = cls.signers.map(s => ({
    name: s.name,
    url: `${baseUrl}/sign.html?class=${req.params.classKey}&signer=${s.id}&token=${s.token}`,
    status: s.status,
  }));
  res.json({ ok: true, links });
});

// ── START ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║      FirmaES Escola — Servidor       ║
╠══════════════════════════════════════╣
║  http://localhost:${PORT}               ║
║  Admin:  http://localhost:${PORT}/admin  ║
║  Pass:   ${ADMIN_PASS}                  ║
╚══════════════════════════════════════╝
  `);
});
