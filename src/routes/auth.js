const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db/pool');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session && req.session.usuario) return res.redirect('/');
  res.render('login', { error: null, activeNav: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.render('login', { error: 'Completá email y contraseña.', activeNav: null });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM usuarios WHERE email = $1 AND activo = TRUE',
      [email.trim().toLowerCase()]
    );

    if (rows.length === 0) {
      return res.render('login', { error: 'Email o contraseña incorrectos.', activeNav: null });
    }

    const usuario = rows[0];
    const match = await bcrypt.compare(password, usuario.password_hash);

    if (!match) {
      return res.render('login', { error: 'Email o contraseña incorrectos.', activeNav: null });
    }

    // Regenerar sesion para prevenir session fixation
    req.session.regenerate((err) => {
      if (err) {
        console.error('Error regenerando sesion:', err);
        return res.render('login', { error: 'Error interno, intentá de nuevo.', activeNav: null });
      }
      req.session.usuario = {
        id: usuario.id,
        nombre: usuario.nombre,
        email: usuario.email,
        rol: usuario.rol,
      };
      res.redirect('/');
    });
  } catch (err) {
    console.error('Error en login:', err);
    res.render('login', { error: 'Error interno, intentá de nuevo.', activeNav: null });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
