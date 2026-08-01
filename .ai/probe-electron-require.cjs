console.log('versions.electron=', process.versions.electron);
console.log('ELECTRON_RUN_AS_NODE=', process.env.ELECTRON_RUN_AS_NODE);
console.log('typeof require electron=', typeof require('electron'));
console.log('electron value=', require('electron'));
try {
  const { app } = require('electron');
  console.log('app=', app);
} catch (e) {
  console.log('destructure error', e.message);
}
process.exit(0);
