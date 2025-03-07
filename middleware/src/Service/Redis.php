<?php

namespace App\Service;

use Predis\Client;

class Redis {
	public function __construct(
		private Client $client = new Client(['host' => 'redis']),
	) {}

	public function get(string $key): mixed {
		$value = $this->client->get($key);
		return json_decode($value, true);
	}

	public function set(string $key, mixed $value) {
		return $this->client->set($key, json_encode($value));
	}

	public function del(string $key) {
		return $this->client->del($key);
	}

	public function exists(string $key): bool {
		return $this->client->exists($key);
	}

	public function clear() {
		$client = $this->client;
		foreach ($this->keys('*') as $key) {
			$client->del($key);
		}
	}

	public function keys(string $pattern): array {
		return $this->client->keys($pattern);
	}
}
