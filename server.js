const express = require('express')
const app = express()
const session = require('express-session')
const FileStore = require('session-file-store')(session)
const upload = require('express-fileupload')
const bodyParser = require('body-parser')
const request = require('request')
const cherrio = require('cheerio')
const site = 'https://micropub-client.herokuapp.com/'
const redirectURI = 'https://micropub-client.herokuapp.com/auth/callback'
const mustacheExpress = require('mustache-express')
const fs = require('fs')

app.set('trust proxy', true)
app.use(session({
  store: new FileStore({path: './.data/sessions'}),
  secret: process.env.SECRET,
  resave: true,
  saveUninitialized: false,
  cookie: { secure: true }
}))
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({extended: true}))
app.use(upload())
app.use(express.static('public'))
app.engine('html', mustacheExpress())
app.set('view engine', 'mustache')

app.get('/', function(req, res) {
  console.log('get /')
  if (hasSession(req)) return res.redirect('/new')
  res.render('index.html')
})

app.get('/login', function(req, res) {
  console.log('get /login')
  if (hasSession(req)) return res.redirect('/new')
  res.render('login.html')
})

app.post('/logout', function(req, res) {
  console.log('post /logout')
  req.session.destroy((err) => {
    console.log(err)
    // LOL no error but [session-file-store] will retry, error on last attempt: Error: ENOENT: no such file or directory
    // https://github.com/valery-barysok/session-file-store/issues/41#issuecomment-271166358
    res.redirect('/login')
  })
})

app.post('/login', async function(req, res) {
  console.log('post /login')
  try {
    const me = req.body.url
    const params = new URLSearchParams()
    const {authorization_endpoint, token_endpoint, micropub} = await(readEndpoints(me))
    if (!(authorization_endpoint && token_endpoint && micropub)) throw Error()
    req.session._mp = {authorization_endpoint, token_endpoint, endpoint: micropub, me}
    params.append('response_type', 'code')
    params.append('scope', 'create')
    params.append('state', 'state')
    params.append('me', me)
    params.append('client_id', site)
    params.append('redirect_uri', redirectURI)
    req.session.save((err) => {
      console.log(err)
      res.redirect(authorization_endpoint + `?${params.toString()}`)
    })
  } catch(err) {
    console.log(err)
    handleError(res, 'Something went wrong when looking up the endpoints.')
  }
})

app.get('/auth/callback', async function(req, res) {
  console.log('get /auth/callback')
  if (req.query.code) {
    try {
      const {me, token_endpoint, endpoint} = req.session._mp
      request.post(token_endpoint, {
        json: true,
        form: {
          grant_type: 'authorization_code',
          me: me,
          code: req.query.code,
          client_id: site,
          redirect_uri: redirectURI
        }
      }, async function(err, resres, body) {
        const config = await getSettings('config', endpoint, body.access_token)
        req.session._mp = {...req.session._mp, access_token: body.access_token, config}
        res.redirect(`/new`)
      })
    } catch(err) {
      console.log(err)
      handleError(res, 'Couldn\'t find token_endpoint.')
    }
  } else {
    handleError(res, `Missing [code] from the returned query: ${(new URLSearchParams(req.query)).toString()}`)
  }
})

app.get('/new', async function(req, res) {
  console.log('get /new')
  if (!hasSession(req)) return res.redirect('/login')
  try {
    const {me, endpoint, config} = req.session._mp
    const locals = {me, endpoint, media_endpoint: config && config['media-endpoint']}
    const action = req.query.action || 'choose'
    locals[action] = true
    res.render('new.html', locals)
  } catch(err) {
    console.log(err)
    handleError(res, 'No micropub endpoint.')
  }
})

app.post('/new', async function(req, res) {
  console.log('post /new')
  let format
  const {endpoint, access_token, config} = req.session._mp
  const options = {
    json: true,
    url: req.query.action === 'upload' ? config['media-endpoint'] : endpoint,
    method: 'post',
    auth: {'bearer': access_token}
  }
  if (req.files && (req.files.photo || req.files.file)) {
    const key = req.files.photo ? 'photo' : 'file'
    req.body[key] = req.files[key].data
    req.body[key].name = req.files[key].name
    format = 'formData'
  } else {
    format = 'form'
  }
  if (req.body.as === 'json') {
    options.body = req.body
    if (req.query.action === 'create') {
      options.body.type = ['h-entry']
      options.body.properties = {content: [req.body.content], category: req.body.category, photo: [req.body.photo]}
    }
  } else {
    options[format] = req.body
  }
  request(options, function(err, resres, body) {
    let error, url
    let result = 'Error'
    if (err) {
      console.log(err)
      error = err
    } else {
      if ([200, 201, 204].indexOf(resres.statusCode) >= 0) {
        result = 'Success'
        url = resres.headers.location
      } else {
        result = resres.statusCode
        error = body ? body.error_description : resres.statusCode
      }
    }
    res.render('result.html', {
      result, error, url
    })
  })
})

function readEndpoints(url) {
  return new Promise(resolve => {
    request(url, function(err, _, body) {
      const obj = {}
      const $ = cherrio.load(body)
      for (const key of ['authorization_endpoint', 'token_endpoint', 'micropub']) {
        obj[key] = $(`link[rel="${key}"]`).attr('href')
      }
      resolve(obj)
    })
  })
}

function handleError(res, error) {
  res.render('result.html', {result: 'Error', error})
}

const listener = app.listen(process.env.PORT, function() {
  console.log('Listening on port ' + listener.address().port)
})

function hasSession(req) {
  const {me, authorization_endpoint, token_endpoint, endpoint, access_token} = req.session._mp || {}
  return me && authorization_endpoint && token_endpoint && endpoint && access_token
}

async function getSettings(type, url, access_token) {
  // type: config / syndicate-to
  return new Promise(resolve => {
    request({url: `${url}?q=${type}`, json: true, auth: {bearer: access_token}}, function(err, res, body) {
      if (err || res.statusCode !== 200 || !body) {
        resolve(null)
      } else {
        resolve(body)
      }
    })
  })
}
