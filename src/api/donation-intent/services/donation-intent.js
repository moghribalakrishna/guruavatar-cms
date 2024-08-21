'use strict';

/**
 * donation-intent service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::donation-intent.donation-intent');
