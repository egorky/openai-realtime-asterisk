export async function setup() {
  try {
    const response = await fetch('http://localhost:4873/');
    if (response.status === 200) {
      console.log('Local npm registry already running');
      return () => {};
    }
  } catch (err) {
    throw new Error('Local npm registry not running');
  }

  return () => {
    // console.log('Shutting down local npm registry');
    // verdaccioServer.kill();
  };
}
