<?php

namespace App\MessageHandler;

use App\Message\MaybeStartProjectMessage;
use App\Service\DDEV;
use App\Service\Redis;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;

#[AsMessageHandler]
class MaybeStartProjectMessageHandler {
	public function __construct(
		private readonly Redis $redis,
		private readonly DDEV $ddev,
	) {}

	public function __invoke(
		MaybeStartProjectMessage $message,
	): void {
		$host = $message->host;

		if (!$host || !$this->redis->exists($host)) {
			return;
		}

		$project = $this->redis->get($host);
		$this->ddev->maybeStart($project['name']);
	}
}
