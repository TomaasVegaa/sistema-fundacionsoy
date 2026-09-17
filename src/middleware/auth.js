// Middleware de autenticacion.
// Redirige a /login si el usuario no tiene sesion activa.

function requireAuth(req, res, next) {
  if (req.session && req.session.usuario) {
    // Hacer disponible el usuario en las vistas
    res.locals.usuario = req.session.usuario;
    return next();
  }
  res.redirect('/login');
}

module.exports = { requireAuth };
