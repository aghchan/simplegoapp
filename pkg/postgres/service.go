package postgres

import (
	"fmt"

	"github.com/aghchan/simplegoapp/pkg/logger"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type Service interface{}

func NewService(
	config map[string]interface{},
	logger logger.Logger,
) Service {
	return &service{
		logger: logger,
		DB: connect(
			logger,
			config["postgres_user"].(string),
			config["postgres_password"].(string),
			config["postgres_host"].(string),
			config["postgres_port"].(string),
			config["postgres_database"].(string),
		),
	}
}

type service struct {
	logger logger.Logger

	DB *gorm.DB
}

func connect(
	logger logger.Logger,
	user, password, host, port, database string,
) *gorm.DB {
	dsn := fmt.Sprintf(
		"postgres://%s:%s@%s:%s/%s",
		user,
		password,
		host,
		port,
		database,
	)
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		logger.Fatal(
			"connecting to postgres",
			"error", err,
		)
	}

	return db
}
