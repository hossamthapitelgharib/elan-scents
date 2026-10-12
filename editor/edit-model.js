/* Editor package entry for the draft model (Node tests + future browser use).
   Full implementation body lives at /edit-model.js (shared with design layer).
   This entry re-exports it so the editor package is the single place to import from. */
if (typeof module === 'object' && module.exports) {
  module.exports = require('../edit-model.js');
} else {
  throw new Error('edit-model browser entry not wired; use Node require or load /edit-model.js');
}
