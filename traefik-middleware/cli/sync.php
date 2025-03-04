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

$process = $ssh->execute('ddev list --json-output');

if (!$process->isSuccessful()) {
	die('failed to get projects');
}

$output = json_decode($process->getOutput(), true);
$projects = $output['raw'] ?? [];

$keys = $redis->keys('*');
$hosts = [];

// Update projects missing from Redis
foreach ($projects as $project) {
	$host = parse_url($project['httpsurl'], PHP_URL_HOST);
	$hosts[] = $host;

	if (!$redis->exists($host)) {
		echo "Adding $host..." . PHP_EOL;
		$redis->set($host, json_encode([
			'host' => $host,
			'name' => $project['name'],
			'status' => $project['status'],
			'last_accessed_at' => time(),
		]));
	}
}

// Delete non existing projects from Redis
foreach($redis->keys('*') as $key) {
	if (!in_array($key, $hosts)) {
		echo "Deleting $host..." . PHP_EOL;
		$redis->del($key);
	}
}
