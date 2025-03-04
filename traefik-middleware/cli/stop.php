#!/usr/bin/env php
<?php

// Load vendors
$autoload_path = __DIR__ . '/../vendor/autoload.php';

if (!file_exists($autoload_path)) {
  http_response_code(500);
  die('missing vendors, run composer install first');
}

require $autoload_path;

$ssh   = (new \Spatie\Ssh\Ssh('studiometa', '51.254.39.148'))->disableStrictHostKeyChecking();
$redis = new \Predis\Client(['host' => getenv('REDIS_HOST')]);

$now = time();
$delay = 3600 * 4;
$delay = 10;

foreach ($redis->keys('*') as $key) {
	$project = json_decode($redis->get($key), true);
	$project_name = $project['name'];

	if ($now - $project['last_accessed_at'] > $delay) {
		echo "Stopping $key..." . PHP_EOL;
		// $process = $ssh->execute("ddev stop $project_name");
		// if ($process->isSuccessful()) {
		// 	echo "Successfully stopped $key!" . PHP_EOL;
		// }
	}
}

