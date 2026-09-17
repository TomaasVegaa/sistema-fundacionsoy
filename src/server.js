const app = require('./app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Fundacion Soy — sistema corriendo en http://localhost:${PORT}`);
});
