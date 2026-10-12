/* Editor package entry for the draft model (Node tests + future browser use).
   Implementation body remains at ../edit-model.js until fully inlined. */
if (typeof module === 'object' && module.exports) {
  module.exports = require('../edit-model.js');
} else {
  throw new Error('edit-model browser entry not wired; use Node require or load /edit-model.js');
}
