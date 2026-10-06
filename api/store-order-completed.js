const storeOrderStatus = require('./store-order-status');

module.exports = function storeOrderCompleted(req, res) {
  if (req.method !== 'POST') {
    return storeOrderStatus(req, res);
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  req.body = {
    ...body,
    status: 'completed',
    order: body.order && typeof body.order === 'object'
      ? { ...body.order, status: 'completed' }
      : body.order,
  };

  return storeOrderStatus(req, res);
};
