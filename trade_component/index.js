const TRADE = require("./controllers/trade");
const _ = require('lodash');
const winston = require('winston');
var logger = new(winston.Logger)({
  transports: [
    new(winston.transports.Console)({
      colorize: 'all'
    }),
    new(winston.transports.File)({ filename: 'trade_log.log' })
  ]
});

let TRADE_CONFIG;
let CURRENCY1;
let CURRENCY2;
let CURRENCY_PAIR;
let STOCK_FEE;
let PROFIT;
let ORDER_LIFE_TIME;
let SPENDING_LIMIT;
let AVG_PRICE_PERIOD;

let tradingIsClosed;

function closeTrading() {
  logger.info('Next iteration of trade will close.');
  tradingIsClosed = true;
}

function initConstants(configs) {
  tradingIsClosed = false;

  TRADE_CONFIG = configs;
  CURRENCY1 = TRADE_CONFIG.trade_config.currency_1;
  CURRENCY2 = TRADE_CONFIG.trade_config.currency_2;
  CURRENCY_PAIR = `${CURRENCY1}_${CURRENCY2}`;
  STOCK_FEE = TRADE_CONFIG.trade_config.stock_fee;
  PROFIT = TRADE_CONFIG.trade_config.profit;
  ORDER_LIFE_TIME = TRADE_CONFIG.trade_config.order_life_time;
  SPENDING_LIMIT = TRADE_CONFIG.trade_config.can_spend;
  AVG_PRICE_PERIOD = TRADE_CONFIG.trade_config.avg_price_period;

  run();
}

let globalTimeout;
const timeoutTime = 180000;

// Help functions
/**
 * To run the logic
 */
function run() {
  TRADE.init_exmo({ key: TRADE_CONFIG.key, secret: TRADE_CONFIG.secret });
  TRADE.api_query("user_open_orders", {}, checkActiveOrders);
}
/** 
 * Get current seconds
 */
function getCurrentSeconds() {
  return ((new Date().getTime() / 1000) + TRADE_CONFIG.trade_config.stock_time_offset * 60 * 60);
}
/**
 * Get passed time
 * @param {integer} pastTime - value in seconds in the past
 */
function getPassedTime(pastTime) {
  return (getCurrentSeconds() - pastTime);
}
/**
 * Wait
 */
function wait() {
  globalTimeout || clearTimeout(globalTimeout);
  globalTimeout = setTimeout(run, timeoutTime);
}
/**
 * Check ask top price (for correcting sell order price)
 */
function checkAskTop(callback) {
  TRADE.api_query('order_book', {
    "pair": CURRENCY_PAIR
  }, (res) => {
    // Orders statistics
    res = JSON.parse(res);
    let currentTopPrice = res[CURRENCY_PAIR].ask_top;
    logger.warn('currentTopPrice', currentTopPrice);
    callback(currentTopPrice);
  });
}

/**
 *  Step #1
 *  To check Active Sell Orders
 */
function checkActiveOrders(orders) {
  // TODO if cllosed - close
  if (!tradingIsClosed) {
    orders = JSON.parse(orders);
    let isNoOrders = _.isEmpty(orders);
  
    let sellOrders = _.filter(orders[CURRENCY_PAIR], { type: 'sell' });
    let buyOrders = _.filter(orders[CURRENCY_PAIR], { type: 'buy' });
  
    // To check active orders
    if (!isNoOrders && _.has(orders, CURRENCY_PAIR)) {
      processExistingOrders(sellOrders, buyOrders);
    } else {
      logger.info('No active orders. Need to sell or buy.');
      // to get conts of currency_1 and currency_2
      TRADE.api_query('user_info', {}, sellBuyCallback);
    }
  }
  else {
    logger.info('Trading closed by user.');
  }
}
/**
 * Step #2
 * To process existing orders
 */
function processExistingOrders(sellOrders, buyOrders) {
  if (sellOrders.length > 0) processExistingSellOrders(sellOrders);
  else if (buyOrders.length > 0) processExistingBuyOrders(buyOrders);
}
/**
 * Step #3.2
 * To process buy orders
 * @param {array} buyOrders - list of user's buy orders 
 */
function processExistingBuyOrders(buyOrders) {
  _.forEach(buyOrders, (order) => {
    TRADE.api_query('order_trades', { 'order_id': order.order_id }, (res) => {
      res = JSON.parse(res);
      let halfExecutedCondition = _.has(res, 'trades') && _.get(res, 'trades').length > 0;

      // To close none half-executed and old orders
      if (!halfExecutedCondition && (getPassedTime(order.created) > ORDER_LIFE_TIME * 60)) {
        logger.warn(`Buy order to old, close it. ID - ${order.order_id}`);
        closeOrder(order);
      } else {
        logger.info(`Order id: ${order.order_id} not so old or half-executed. Will check again after ${(timeoutTime/1000)/60} minutes.`);
        wait();
      }
    });
  });
}
/**
 * Step #3.1
 * To process sell orders
 * @param {array} sellOrders - list of user's buy orders 
 */
function processExistingSellOrders(sellOrders) {
  checkAskTop((currentTopPrice) => {
    /**
     * If currentTopPrice higher than price of existing sell order, close current sell order.
     * After system timeout new Sell order will be created with up-to-date price
     */
    _.forEach(sellOrders, (order) => {
      if (currentTopPrice > order.price) {
        closeOrder(order);
      } else {
        logger.info(`Order ID - ${order.order_id}. Will check again after ${(timeoutTime/1000)/60} minutes.`);
        wait();
      }
    });
  });
}
/**
 * Step #4
 * To close old order
 */
function closeOrder(order) {
  TRADE.api_query('order_cancel', { "order_id": order.order_id }, (res) => {
    res = JSON.parse(res);
    logger.warn(`Close the ${order.type} order. Result is - ${res.result}`);
    wait();
  });
}
/**
 * Step #5
 * Callback function. To process creating buy or sell order
 * @param {*} res - user_info response 
 */
function sellBuyCallback(res) {
  res = JSON.parse(res);

  // Check if some currency_1 exists to sell
  if (parseFloat(res.balances[CURRENCY1]) > 0) {
    // Create sell order
    createSellOrder(res.balances[CURRENCY1]);
  } else if (parseFloat(res.balances[CURRENCY2]) >= SPENDING_LIMIT) {
    // Create buy order
    createBuyOrder();
  } else {
    logger.warn('No money');
    wait();
  }
}
/**
 * Step #6
 * To create Sell order
 * @param {*} sellCurrencyBalance 
 */
function createSellOrder(sellCurrencyBalance) {
  logger.info('Create Sell order');
  let wannaGet = SPENDING_LIMIT + SPENDING_LIMIT * (STOCK_FEE + PROFIT);
  let price = wannaGet / parseFloat(sellCurrencyBalance);

  logger.warn('Sell info: ', JSON.stringify({ CURRENCY_PAIR, wannaGet, price, sellCurrencyBalance }, null, 2));

  checkAskTop((currentTopPrice) => {
    price = currentTopPrice > price ? currentTopPrice : price;

    TRADE.api_query('order_create', {
      'pair': CURRENCY_PAIR,
      'quantity': sellCurrencyBalance,
      'price': price,
      'type': 'sell'
    }, (res) => {
      res = JSON.parse(res);
      if (res.result === true && _.isEmpty(res.error)) logger.info(`Sell order created. id: ${res.order_id}`);
      else logger.error('Something went wrong, got error when try to sell');
      wait();
    });
  });
}
/**
 * Step #7
 * To create Buy order
 */
function createBuyOrder() {
  logger.info('Calculate price and amount for Buy');

  TRADE.api_query('trades', {
    "pair": CURRENCY_PAIR
  }, (res) => {
    // Orders statistics
    res = JSON.parse(res);

    let getPricesByPeriod = _.reduce(res[CURRENCY_PAIR], function(result, value) {
      let condition = getPassedTime(parseFloat(value.date)) < AVG_PRICE_PERIOD * 60;
      if (condition) result.push(parseFloat(value.price));
      return result;
    }, []);

    let avgPrice = _.sum(getPricesByPeriod) / getPricesByPeriod.length;

    let myNeedPrice = avgPrice - avgPrice * (STOCK_FEE + PROFIT);
    let myAmount = SPENDING_LIMIT / myNeedPrice;

    logger.warn('Buy info: ', JSON.stringify({ avgPrice, myNeedPrice, myAmount }, null, 2));

    TRADE.api_query('pair_settings', {}, (res) => {
      let quantity = JSON.parse(res)[CURRENCY_PAIR].min_quantity;

      if (myAmount >= quantity) {
        logger.info('Creating BUY order');

        TRADE.api_query('order_create', {
          'pair': CURRENCY_PAIR,
          'quantity': myAmount,
          'price': myNeedPrice,
          'type': 'buy'
        }, (res) => {
          res = JSON.parse(res);
          if (res.result === true && _.isEmpty(res.error)) logger.info(`Buy order created. id: ${res.order_id}`);
          else logger.error('Something went wrong, got error when try to buy');
          wait();
        });
      } else {
        logger.warn('WARN. Have no money to create Buy Order');
        wait();
      }
    });
  });
}

// const TRADE_CONFIG = require("./config")
// initConstants(TRADE_CONFIG);

exports.init = initConstants;
exports.closeTrading = closeTrading;