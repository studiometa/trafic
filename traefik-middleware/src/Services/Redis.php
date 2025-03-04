<?php

namespace Studiometa\DdevServer\Services;

use Exception;
use Predis\Client;
use Studiometa\DDevServer\Traits\Singleton;

class Redis {
	use Singleton;

	protected function __construct(
		protected Client $client = new Client(['host' => getenv('REDIS_HOST')])
	) { }

	public static function get(string $key): mixed {
		$value = self::getInstance()->client->get($key);
		try {
			return json_decode($value, true);
		} catch (Exception $exception) {
			return null;
		}
	}

	public function set(string $key, mixed $value) {
		return self::getInstance()->client->set($key, json_encode($value));
	}

	public function del(string $key) {
		return self::getInstance()->client->del($key);
	}

	public function exists(string $key): bool {
		return self::getInstance()->client->exists($key);
	}

	public function clear() {
		$client = self::getInstance()->client;
		foreach ($client->keys('*') as $key) {
			$client->del($key);
		}
	}
}
