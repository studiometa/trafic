<pre><?php

// Load vendors
$autoload_path = __DIR__ . '/../vendor/autoload.php';

if (!file_exists($autoload_path)) {
  http_response_code(500);
  die('missing vendors, run composer install first');
}

require $autoload_path;

$redis  = new \Predis\Client(['host' => getenv('REDIS_HOST')]);
$host   = $_SERVER['HTTP_HOST'];
$status = (int) ($_REQUEST['status'] ?? 404);

foreach ($redis->keys('*') as $key) {
	var_dump($redis->get($key));
}
die;

http_response_code($status);

if ($status !== 404 || !$redis->get($host)) {
	die(sprintf('<p><b>%s</b></p><p>Oops, an error occured, try again later.</p>', $status));
}
?>

<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Studio Meta</title>
</head>
<body>
	<main>
		<p>Dû à une inactivité prolongée,<br>cet environnement a été désactivé.</p>
		<div id="status"></div>
	</main>

	<script type="module">
		const state = document.querySelector('#status');

		async function test() {
			const { status } = await fetch(location).catch(() => {});

			switch (status) {
				case 200:
					location.reload();
					break;
				case 502:
					setTimeout(test, 500);
					state.textContent = 'Le serveur redémarre...';
					break;
				default:
					state.textContent = 'Encore un petit instant...';
					setTimeout(test, 500);
					break;
			}
		}

		test();
	</script>
</body>
</html>

