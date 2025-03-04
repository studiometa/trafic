<?php

// Load vendors
$autoload_path = __DIR__ . '/../vendor/autoload.php';

if (!file_exists($autoload_path)) {
  http_response_code(500);
  die('missing vendors, run composer install first');
}

require $autoload_path;

$redis = new \Predis\Client(['host' => getenv('REDIS_HOST')]);

// Delete non existing projects from Redis
foreach($redis->keys('*') as $key) {
	echo "Deleting $key..." . PHP_EOL;
	$redis->del($key);
}
