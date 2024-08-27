<?php
// Available auth methods: IP, token or basic auth.
$ip = $_SERVER['HTTP_CF_CONNECTING_IP']
  ?? $_SERVER['HTTP_X_REAL_IP']
  ?? $_SERVER['HTTP_X_FORWARDED_FOR']
  ?? $_SERVER['REMOTE_ADDR']
  ?? null;

$token     = $_SERVER['HTTP_X_DDEV_AUTH_TOKEN'] ?? null;
$subdomain = $_SERVER['HTTP_X_FORWARDED_HOST']
  ? current(explode('.', $_SERVER['HTTP_X_FORWARDED_HOST']))
  : null;

$user      = $_SERVER['PHP_AUTH_USER'] ?? null;
$password  = $_SERVER['PHP_AUTH_PW'] ?? null;

// Get allowed credentials.
$config_dir         = __DIR__ . '/../config';
$allowed_ips        = require($config_dir . '/ips.php');
$allowed_tokens     = require($config_dir . '/tokens.php');
$allowed_subdomains = require($config_dir . '/subdomains.php');
$allowed_users      = require($config_dir . '/users.php');

// IP detection
if (in_array($ip, $allowed_ips)) {
  http_response_code(200);
  die('ip authorized');
}

// Header token detection
if ($token && in_array($token, $allowed_tokens)) {
  http_response_code(200);
  die('token authorized');
}

// Subdomain detection
if ($subdomain && in_array($subdomain, $allowed_subdomains)) {
  http_response_code(200);
  die('subdomains authorized');
}

$is_valid_user = ($allowed_users[$user] ?? null) === $password;

// Basic auth detection
if ($user && $password && $is_valid_user) {
  http_response_code(200);
  die('user authorized');
}

http_response_code(401);
header('www-authenticate: Basic realm="Identification"');
die('not authorized');
