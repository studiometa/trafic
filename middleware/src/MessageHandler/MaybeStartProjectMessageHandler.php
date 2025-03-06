<?php

namespace App\MessageHandler;

use App\Message\MaybeStartProjectMessage;
use App\Service\DDEV;
use App\Service\Redis;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;

#[AsMessageHandler]
class MaybeStartProjectMessageHandler {
	public function __invoke(
		MaybeStartProjectMessage $message,
		Redis $redis,
		DDEV $ddev
	): void {
		$host = $message->host;

		if (!$host || !$redis->exists($host)) {
			return;
		}

		$project = $redis->get($host);
		$ddev->maybeStart($project['name']);
	}
}
