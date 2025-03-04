<?php

// Load vendors
$autoload_path = __DIR__ . '/../vendor/autoload.php';

if (!file_exists($autoload_path)) {
  http_response_code(500);
  die('missing vendors, run composer install first');
}

require $autoload_path;

$redis = new \Predis\Client(['host' => getenv('REDIS_HOST')]);
$host = $_SERVER['HTTP_X_FORWARDED_HOST'] ?? null;
var_dump($host);
// @todo try to start project if exists and stopped
// $redis->set($_SERVER['HTTP_X_FORWARDED_HOST'], time());
if ($host && $redis->exists($host)) {
  $project = json_decode($redis->get($host), true);
  $project_name = $project['name'];
  $project['last_accessed_at'] = time();
  if ($project['status'] === 'stopped') {
    echo "Starting $project_name..." . PHP_EOL;
    $ssh = (new \Spatie\Ssh\Ssh('studiometa', '51.254.39.148'))->disableStrictHostKeyChecking();
    $process = $ssh->execute("ddev start $project_name");
    if ($process->isSuccessful()) {
      echo "started $project_name!" . PHP_EOL;
      echo $process->getOutput();
    } else {
      echo "failed to start $project_name" . PHP_EOL;
      echo $process->getErrorOutput();
    }
  }

  $redis->set($host, json_encode($project));
  echo "updating $host..." . PHP_EOL;
}

// Available auth methods: IP, token or basic auth.
$ip = $_SERVER['HTTP_CF_CONNECTING_IP']
  ?? $_SERVER['HTTP_X_REAL_IP']
  ?? $_SERVER['HTTP_X_FORWARDED_FOR']
  ?? $_SERVER['REMOTE_ADDR']
  ?? null;

$token       = $_SERVER['HTTP_X_DDEV_AUTH_TOKEN'] ?? null;
$subdomain   = $host ? current(explode('.', $host)) : null;
$user        = $_SERVER['PHP_AUTH_USER'] ?? null;
$password    = $_SERVER['PHP_AUTH_PW'] ?? null;
$config_path = __DIR__ . '/../auth.config.php';

if (!file_exists($config_path)) {
  http_response_code(409);
  die('missing auth.config.php configuration file');
}

// Get configured credentials.
$config             = require($config_path);
$allowed_ips        = $config['ips'];
$allowed_tokens     = $config['tokens'];
$allowed_subdomains = $config['subdomains'];
$allowed_users      = $config['users'];

// @todo log access here, use redis?

// IP detection
if (in_array($ip, $allowed_ips)) {
  http_response_code(200);
  die('ip authorized');
}

// Authorize local IPs
if (str_starts_with($ip, '127.0.') || str_starts_with($ip, '192.168.')) {
  http_response_code(200);
  die('local ip authorized');
}

// Header token detection
if ($token && in_array($token, $allowed_tokens)) {
  http_response_code(200);
  die('token authorized');
}

// Subdomain detection
if ($subdomain && in_array($subdomain, $allowed_subdomains)) {
  http_response_code(200);
  die('subdomain authorized');
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
