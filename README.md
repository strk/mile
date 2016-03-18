# pile

## Environment variables

`PILE_CONFIG_PATH` - full path to pile-config.js

### Database access

Accessed database hostname is hardcoded to be `postgis`.

`SYSTEMAPIC_PGSQL_USERNAME` - username to access db
`SYSTEMAPIC_PGSQL_PASSWORD` - password to access db

## Testing

Tests are meant to be run from within the docker appropriately
started with all links expected from the systemapic-docker
configuration.

Inside such docker, tests are run using:

```sh
 npm test
````
