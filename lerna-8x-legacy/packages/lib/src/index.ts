const _ = require("lodash");
const libVar = _.last([1, 2, 7]);

console.log(`libVar: ${libVar}`);

module.exports = {
  libVar,
};
