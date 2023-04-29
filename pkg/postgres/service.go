package postgres

import (
	"fmt"

	"github.com/aghchan/simplegoapp/pkg/logger"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type Service interface {
	Insert(objects interface{}) error
	Find(model interface{}, filter string) error
}

func NewService(
	config map[string]interface{},
	logger logger.Logger,
) Service {
	return &service{
		logger: logger,
		db: connect(
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

	db *gorm.DB
}

func (this service) Insert(objects interface{}) error {
	return this.db.Create(objects).Error
}

func (this service) Find(model interface{}, filter string) error {
	return this.db.Where(filter).Find(model).Error
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
