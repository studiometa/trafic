<?php
$status = (int) ($_REQUEST['status'] ?? 404);
http_response_code($status);

function render_error(int $code):string {
	return sprintf('<p><b>%s</b></p><p>Oops, an error occured, try again later.</p>', $code);
}

function project_exists() {
    // @todo improve project list generation
    $filepath = __DIR__ . '/../ddev-projects.json';

    if (!file_exists($filepath)) {
        return;
    }

	$projects = json_decode(file_get_contents($filepath));

	$projects_hosts = array_map(function($project) {
		return parse_url($project->primary_url, PHP_URL_HOST);
	}, $projects);

	return in_array($_SERVER['HTTP_HOST'], $projects_hosts);
}

if ($status !== 404 || !project_exists()) {
	die(render_error($status));
}
?>

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
