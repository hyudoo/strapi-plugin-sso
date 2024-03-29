const axios = require("axios");
const { v4 } = require('uuid');

let id_token;

const configValidation = () => {
  const config = strapi.config.get('plugin.strapi-sso-plugin')
  if (config['OIDC_CLIENT_ID'] && config['OIDC_CLIENT_SECRET']
      && config['OIDC_REDIRECT_URI'] && config['OIDC_SCOPES']
      && config['OIDC_TOKEN_ENDPOINT'] && config['OIDC_USER_INFO_ENDPOINT']
      && config['OIDC_GRANT_TYPE'] && config['OIDC_FAMILY_NAME_FIELD']
    && config['OIDC_GIVEN_NAME_FIELD'] && config['OIDC_AUTHORIZATION_ENDPOINT']
    && config['OIDC_LOGOUT_ENDPOINT'] && config['OIDC_REDIRECT_URI_LOGOUT']
  ) {
    return config
  }
  throw new Error('OIDC_AUTHORIZATION_ENDPOINT,OIDC_TOKEN_ENDPOINT, OIDC_USER_INFO_ENDPOINT,OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI, and OIDC_SCOPES are required')
}

const oidcSignIn = async (ctx) => {
  const { state } = ctx.query;
  const { OIDC_CLIENT_ID, OIDC_REDIRECT_URI, OIDC_SCOPES, OIDC_AUTHORIZATION_ENDPOINT } = configValidation();

  const authorizationUrl = `${OIDC_AUTHORIZATION_ENDPOINT}?response_type=code&client_id=${OIDC_CLIENT_ID}&redirect_uri=${OIDC_REDIRECT_URI}&scope=${OIDC_SCOPES}`;

  ctx.redirect(authorizationUrl);
};

const oidcSignInCallback = async (ctx) => {
  const config = configValidation()
  const httpClient = axios.create()
  const userService = strapi.service('admin::user')
  const tokenService = strapi.service('admin::token')
  const oauthService = strapi.plugin('strapi-sso-plugin').service('oauth')
  const roleService = strapi.plugin('strapi-sso-plugin').service('role')

  if (!ctx.query.code) {
    return ctx.send(oauthService.renderSignUpError(`code Not Found`))
  }

  const params = new URLSearchParams();
  params.append('code', ctx.query.code);
  params.append('client_id', config['OIDC_CLIENT_ID']);
  params.append('client_secret', config['OIDC_CLIENT_SECRET']);
  params.append('redirect_uri', config['OIDC_REDIRECT_URI']);
  params.append('grant_type', config['OIDC_GRANT_TYPE']);

  try {
    const response = await httpClient.post(config['OIDC_TOKEN_ENDPOINT'], params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    })
    id_token = response?.data?.id_token;

    let userInfoEndpointHeaders = {};
    let userInfoEndpointParameters = `?access_token=${response.data.access_token}`;

    if (config["OIDC_USER_INFO_ENDPOINT_WITH_AUTH_HEADER"]) {
      userInfoEndpointHeaders = {
        headers: { Authorization: `Bearer ${response.data.access_token}` },
      };
      userInfoEndpointParameters = "";
    }

    const userInfoEndpoint = `${config["OIDC_USER_INFO_ENDPOINT"]}${userInfoEndpointParameters}`;

    const userResponse = await httpClient.get(
      userInfoEndpoint,
      userInfoEndpointHeaders
      );

    const email =  userResponse.data.email
    const dbUser = await userService.findOneByEmail(email)
    let activateUser;
    let jwtToken;

    if (dbUser) {
      // Already registered
      activateUser = dbUser;
      jwtToken = await tokenService.createJwtToken(dbUser)
    } else {
      // Register a new account
      const oidcRoles = await roleService.oidcRoles()
      const roles = oidcRoles && oidcRoles['roles'] ? oidcRoles['roles'].map(role => ({
        id: role
      })) : []

      const defaultLocale = oauthService.localeFindByHeader(ctx.request.headers)
      activateUser = await oauthService.createUser(
        email,
        userResponse.data[config['OIDC_FAMILY_NAME_FIELD']],
        userResponse.data[config['OIDC_GIVEN_NAME_FIELD']],
        defaultLocale,
        roles,
      )
      jwtToken = await tokenService.createJwtToken(activateUser)

      // Trigger webhook
      await oauthService.triggerWebHook(activateUser)
    }
    // Login Event Call
    oauthService.triggerSignInSuccess(activateUser)

    // Client-side authentication persistence and redirection
    const nonce = v4()
    const html = oauthService.renderSignUpSuccess(jwtToken, activateUser, nonce)
    ctx.set('Content-Security-Policy', `script-src 'nonce-${nonce}'`)
    ctx.send(html);
  } catch (e) {
    console.error(e)
    ctx.send(oauthService.renderSignUpError(e.message))
  }
};

const oidcLogout = async (ctx) => {
  try {
    const { OIDC_SCOPES, OIDC_LOGOUT_ENDPOINT, OIDC_REDIRECT_URI_LOGOUT } = configValidation();
   
    const logoutUrl = `${OIDC_LOGOUT_ENDPOINT}?post_logout_redirect_uri=${OIDC_REDIRECT_URI_LOGOUT}&scope=${OIDC_SCOPES}&id_token_hint=${id_token}`;
    ctx.redirect(logoutUrl);
  } catch (e) {
    console.error(e)
  }
};

const oidcLogoutCallback = async (ctx) => {
  ctx.redirect('/strapi-sso-plugin/oidc')
};

module.exports = {
  oidcSignIn,
  oidcSignInCallback,
  oidcLogout,
  oidcLogoutCallback
};
