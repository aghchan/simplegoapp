package postgres

import (
	"fmt"

	"github.com/aghchan/simplegoapp/pkg/logger"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type Service interface {
	RunMigrations(models []interface{})

	Find(model interface{}, query, args string) error
	GetOrCreate(result, object interface{}) error
	Insert(objects interface{}) error
}

func NewService(
	config map[string]interface{},
	logger logger.Logger,
) Service {
	service := &service{
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

	return service
}

type service struct {
	logger logger.Logger

	db *gorm.DB
}

func (this service) Insert(objects interface{}) error {
	return this.db.Create(objects).Error
}

func (this service) GetOrCreate(result, conditions interface{}) error {
	err := this.db.FirstOrCreate(result, conditions).Error
	if err != nil {
		this.logger.Error(
			"GetOrCreate",
			"error", err,
		)

		return err
	}

	return nil
}

func (this service) Find(model interface{}, filter, args string) error {
	query := this.db
	if filter != "" && args != "" {
		query = query.Where(filter, filter, args)
	}

	return query.Find(model).Error
}

func (this service) RunMigrations(models []interface{}) {
	if err := this.db.AutoMigrate(models...); err != nil {
		this.logger.Fatal(
			"running migration",
			"error", err,
		)
	}
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
