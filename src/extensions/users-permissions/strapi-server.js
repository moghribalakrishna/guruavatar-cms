module.exports = (plugin) => {
    plugin.controllers.user.me = async (ctx) => {
      if (!ctx.state.user) {
        return ctx.unauthorized();
      }
      const user = await strapi.entityService.findOne(
        'plugin::users-permissions.user',
        ctx.state.user.id,
        { populate: ['role'] }
      );
      ctx.body = user;
    };
  
    plugin.controllers.user.register = async (ctx) => {
      const pluginStore = strapi.store({
        environment: '',
        type: 'plugin',
        name: 'users-permissions',
      });
  
      const settings = await pluginStore.get({
        key: 'advanced',
      });
  
      if (!settings.allow_register) {
        throw new ApplicationError('Register action is currently disabled');
      }
  
      const { email, username, password, interests, educationLevel } = ctx.request.body;
  
      const user = await strapi.plugins['users-permissions'].services.user.add({
        email,
        username,
        password,
        interests,
        educationLevel,
        provider: 'local',
      });
  
      const jwt = strapi.plugins['users-permissions'].services.jwt.issue(
        _.pick(user.toJSON ? user.toJSON() : user, ['id'])
      );
  
      return {
        jwt,
        user: await strapi.plugins['users-permissions'].services.user.sanitizeUser(user),
      };
    };
    return plugin;
  };