'use strict';

/**
 * course-suggestion service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::course-suggestion.course-suggestion');
